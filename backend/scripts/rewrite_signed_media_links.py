# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One-off rewrite: stored signed media URLs → stable authenticated app paths.

Before WP2 the editor stored 1-hour signed GCS URLs in rich text, so every
image older than an hour is broken. This rewrites them, in place, to the
durable `/api/workspaces/{slug}/media/…` and `…/resources/{id}/content` paths,
using the same pure `canonicalize_*` functions the write path runs on every
save. Absolute local-storage URLs, and absolute links to the stable paths on
the app's own origin (stored by the pre-PR-B editor), are made relative too.

Tables: notes.content, cards.description, boards.description,
definitions.scope and definitions.content (whose rich text is PM-JSON strings
nested at `scope` and `decisions[].rationale`). notes.findings,
completion_candidates.summary and activities.message_params are counted only.

Run it only after the WP2 backend and frontend are fully rolled out (no old
revision still minting signed URLs), from a shell against the target DB:

    source .venv/bin/activate

    # 1. Dry run (the default): per-table/per-workspace counts, unmapped links.
    python -m scripts.rewrite_signed_media_links --preview /tmp/wp2-diff.jsonl

    # 2. After owner review and a completed on-demand DB backup:
    python -m scripts.rewrite_signed_media_links --apply \\
        --snapshot gs://<ops-bucket>/wp2/rewrite-<ts>.jsonl --backup-ref <backup-id>

    # 3. A second dry run must report `changes: 0`.

    # Roll back (dry run without --apply): restores `before` only where the
    # value is still exactly what this script wrote.
    python -m scripts.rewrite_signed_media_links --restore <snapshot> --apply

Writes are compare-and-swap on the value read at discovery, so a row a human
edits mid-run is skipped (the next run picks it up). `updated_at` is written
back unchanged; no activity rows are recorded. Each batch commits in its own
transaction.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from collections import Counter
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from pathlib import Path

from sqlalchemy import Text, cast, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.activity import Activity
from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.completion import CompletionCandidate
from app.models.notes.note import Note
from app.models.workspace import Workspace
from app.repositories.resources.resource import ResourceRepository
from app.services.media.links import (
    GCS_HOST,
    LOCAL_DOWNLOAD_PREFIX,
    STABLE_PATH_PREFIX,
    LinkRewriteReport,
    MediaLinkContext,
    app_origins_from_settings,
    canonicalize_definition,
    normalize_origin,
    canonicalize_rich_text,
    collect_definition_resource_keys,
    collect_resource_keys,
)

DEFAULT_BATCH_SIZE = 200
UNMAPPED_SAMPLE_SIZE = 20

# The JSON column is compared and snapshotted as text: Postgres `json` keeps
# the exact text it was given, and SQLAlchemy writes it with json.dumps.
_COLUMNS = {
    ("notes", "content"): (Note, Note.content),
    ("cards", "description"): (Card, Card.description),
    ("boards", "description"): (Board, Board.description),
    ("definitions", "scope"): (Definition, Definition.scope),
    ("definitions", "content"): (Definition, cast(Definition.content, Text)),
}
_JSON_COLUMNS = {("definitions", "content")}

_REPORT_ONLY = {
    "notes.findings": cast(Note.findings, Text),
    "completion_candidates.summary": CompletionCandidate.summary,
    "activities.message_params": cast(Activity.message_params, Text),
}


@dataclass(frozen=True)
class RowChange:
    table: str
    pk: str
    column: str
    workspace_id: str
    before: str
    after: str
    updated_at: str


@dataclass(frozen=True)
class UnmappedHit:
    table: str
    pk: str
    workspace_id: str
    url: str
    reason: str


@dataclass
class Discovery:
    changes: list[RowChange] = field(default_factory=list)
    unmapped: list[UnmappedHit] = field(default_factory=list)
    report_only_hits: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ApplyResult:
    applied: int
    skipped: int


def _may_hold_storage_link(column):
    return or_(
        column.like(f"%{GCS_HOST}%"),
        column.like(f"%{LOCAL_DOWNLOAD_PREFIX}%"),
        column.like(f"%://%{STABLE_PATH_PREFIX}%"),
    )


class _ContextCache:
    def __init__(self, db: AsyncSession, bucket: str, app_origins: frozenset[str]):
        self.db = db
        self.bucket = bucket
        self.app_origins = app_origins
        self._slugs: dict[uuid.UUID, str] = {}

    async def base(self, workspace_id: uuid.UUID) -> MediaLinkContext:
        if workspace_id not in self._slugs:
            self._slugs[workspace_id] = await self.db.scalar(
                select(Workspace.slug).where(Workspace.id == workspace_id)
            )
        return MediaLinkContext(
            workspace_id=workspace_id,
            workspace_slug=self._slugs[workspace_id],
            bucket=self.bucket,
            app_origins=self.app_origins,
        )

    async def with_resources(self, ctx: MediaLinkContext, keys: set[str]) -> MediaLinkContext:
        resource_ids = await ResourceRepository(self.db).ids_by_gcs_path(ctx.workspace_id, keys)
        return replace(ctx, resource_ids_by_key=resource_ids)


async def _keyset_rows(db: AsyncSession, query, pk_column, batch_size: int):
    last_pk = None
    while True:
        page = query.order_by(pk_column).limit(batch_size)
        if last_pk is not None:
            page = page.where(pk_column > last_pk)
        rows = (await db.execute(page)).all()
        if not rows:
            return
        for row in rows:
            yield row
        last_pk = rows[-1][0]


def _record(discovery: Discovery, table: str, pk, workspace_id, report: LinkRewriteReport) -> None:
    for link in report.unmapped:
        discovery.unmapped.append(
            UnmappedHit(table=table, pk=str(pk), workspace_id=str(workspace_id), url=link.url, reason=link.reason)
        )


def _change(table, column, pk, workspace_id, before, after, updated_at) -> RowChange:
    return RowChange(
        table=table, pk=str(pk), column=column, workspace_id=str(workspace_id),
        before=before, after=after, updated_at=updated_at.isoformat(),
    )


async def discover(
    session_factory: async_sessionmaker,
    *,
    bucket: str,
    app_origins: frozenset[str] | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> Discovery:
    """`app_origins`: origins whose absolute stable links are made relative
    (default: the configured FRONTEND_URL / API_URL / CORS_ORIGINS)."""
    if app_origins is None:
        app_origins = app_origins_from_settings()
    discovery = Discovery()
    single_string_sources = [
        ("notes", "content", select(Note.id, Note.workspace_id, Note.content, Note.updated_at)
            .where(_may_hold_storage_link(Note.content)), Note.id),
        ("cards", "description", select(Card.id, Board.workspace_id, Card.description, Card.updated_at)
            .join(Board, Board.id == Card.board_id)
            .where(_may_hold_storage_link(Card.description)), Card.id),
        ("boards", "description", select(Board.id, Board.workspace_id, Board.description, Board.updated_at)
            .where(_may_hold_storage_link(Board.description)), Board.id),
    ]
    async with session_factory() as db:
        contexts = _ContextCache(db, bucket, app_origins)
        for table, column, query, pk_column in single_string_sources:
            async for pk, workspace_id, value, updated_at in _keyset_rows(db, query, pk_column, batch_size):
                ctx = await contexts.base(workspace_id)
                ctx = await contexts.with_resources(ctx, collect_resource_keys(value, ctx))
                after, report = canonicalize_rich_text(value, ctx)
                _record(discovery, table, pk, workspace_id, report)
                if after != value:
                    discovery.changes.append(_change(table, column, pk, workspace_id, value, after, updated_at))

        content_text = cast(Definition.content, Text)
        definitions = select(
            Definition.id, Definition.workspace_id, Definition.scope, content_text, Definition.updated_at
        ).where(or_(_may_hold_storage_link(Definition.scope), _may_hold_storage_link(content_text)))
        async for pk, workspace_id, scope, content_json, updated_at in _keyset_rows(
            db, definitions, Definition.id, batch_size
        ):
            content = json.loads(content_json) if content_json else None
            ctx = await contexts.base(workspace_id)
            ctx = await contexts.with_resources(ctx, collect_definition_resource_keys(scope, content, ctx))
            new_scope, new_content, report = canonicalize_definition(scope, content, ctx)
            _record(discovery, "definitions", pk, workspace_id, report)
            if new_scope != scope:
                discovery.changes.append(
                    _change("definitions", "scope", pk, workspace_id, scope, new_scope, updated_at)
                )
            if new_content is not content:
                discovery.changes.append(
                    _change("definitions", "content", pk, workspace_id, content_json,
                            json.dumps(new_content), updated_at)
                )

        for name, column in _REPORT_ONLY.items():
            discovery.report_only_hits[name] = await db.scalar(
                select(func.count()).where(_may_hold_storage_link(column))
            )
    return discovery


async def _compare_and_swap(db: AsyncSession, change: RowChange) -> bool:
    model, compared_column = _COLUMNS[(change.table, change.column)]
    is_json = (change.table, change.column) in _JSON_COLUMNS
    new_value = json.loads(change.after) if is_json else change.after
    result = await db.execute(
        update(model)
        .where(model.id == uuid.UUID(change.pk), compared_column == change.before)
        .values({change.column: new_value, "updated_at": datetime.fromisoformat(change.updated_at)})
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def apply_changes(
    session_factory: async_sessionmaker, changes: list[RowChange], *, batch_size: int = DEFAULT_BATCH_SIZE
) -> ApplyResult:
    applied = skipped = 0
    for start in range(0, len(changes), batch_size):
        # A bare session rolls back on close; the batch must own its commit.
        async with session_factory() as db, db.begin():
            for change in changes[start : start + batch_size]:
                if await _compare_and_swap(db, change):
                    applied += 1
                else:
                    skipped += 1
                    print(f"SKIPPED (changed since discovery) {change.table}.{change.column} {change.pk}")
    return ApplyResult(applied=applied, skipped=skipped)


def _snapshot_lines(changes: list[RowChange], backup_ref: str) -> str:
    header = {"kind": "header", "backup_ref": backup_ref, "rows": len(changes)}
    return "".join(json.dumps(line) + "\n" for line in [header, *map(asdict, changes)])


def write_snapshot(dest: str, changes: list[RowChange], *, backup_ref: str) -> None:
    """Persist every planned change before any write; never overwrite."""
    data = _snapshot_lines(changes, backup_ref)
    if dest.startswith("gs://"):
        from google.cloud import storage

        bucket_name, _, object_name = dest.removeprefix("gs://").partition("/")
        storage.Client().bucket(bucket_name).blob(object_name).upload_from_string(
            data, content_type="application/x-ndjson", if_generation_match=0
        )
        return
    with Path(dest).open("x", encoding="utf-8") as snapshot:
        snapshot.write(data)


def read_snapshot(source: str) -> list[RowChange]:
    if source.startswith("gs://"):
        from google.cloud import storage

        bucket_name, _, object_name = source.removeprefix("gs://").partition("/")
        text = storage.Client().bucket(bucket_name).blob(object_name).download_as_text()
    else:
        text = Path(source).read_text(encoding="utf-8")
    lines = [json.loads(line) for line in text.splitlines() if line.strip()]
    return [RowChange(**line) for line in lines if line.get("kind") != "header"]


async def restore(session_factory: async_sessionmaker, snapshot: str, *, apply: bool) -> ApplyResult:
    reverse = [replace(change, before=change.after, after=change.before) for change in read_snapshot(snapshot)]
    print(f"restore: {len(reverse)} rows in snapshot")
    if not apply:
        print("DRY RUN — pass --apply to restore")
        return ApplyResult(applied=0, skipped=0)
    return await apply_changes(session_factory, reverse)


def _print_report(discovery: Discovery, *, apply: bool) -> None:
    print("APPLY" if apply else "DRY RUN — nothing is written without --apply")
    print(f"changes: {len(discovery.changes)}")
    for name, count in sorted(Counter(f"{c.table}.{c.column}" for c in discovery.changes).items()):
        print(f"  {name}: {count}")
    for workspace_id, count in sorted(Counter(c.workspace_id for c in discovery.changes).items()):
        print(f"  workspace {workspace_id}: {count}")
    print(f"unmapped (left unchanged): {len(discovery.unmapped)}")
    for reason, count in sorted(Counter(u.reason for u in discovery.unmapped).items()):
        print(f"  {reason}: {count}")
    for hit in discovery.unmapped[:UNMAPPED_SAMPLE_SIZE]:
        print(f"  sample {hit.table} {hit.pk} ws={hit.workspace_id} {hit.reason}: {hit.url[:160]}")
    print("report-only (not rewritten):")
    for name, count in discovery.report_only_hits.items():
        print(f"  {name}: {count}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    parser.add_argument("--bucket", default=None, help="GCS bucket the signed URLs point at (default: GCS_BUCKET)")
    parser.add_argument(
        "--app-origin",
        action="append",
        help="origin the app is served from, e.g. https://intern.example (repeatable; "
        "default: FRONTEND_URL, API_URL and CORS_ORIGINS)",
    )
    parser.add_argument("--snapshot", help="JSONL snapshot written before any change (local path or gs://)")
    parser.add_argument("--backup-ref", help="id of the completed on-demand DB backup taken before --apply")
    parser.add_argument("--preview", help="write the full JSONL diff of planned changes to this path")
    parser.add_argument("--restore", metavar="SNAPSHOT", help="put back the `before` values from a snapshot")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    return parser.parse_args(argv)


async def run(args: argparse.Namespace, session_factory: async_sessionmaker) -> int:
    if args.restore:
        result = await restore(session_factory, args.restore, apply=args.apply)
        print(f"restored: {result.applied}, skipped: {result.skipped}")
        return 0
    if args.apply and not (args.snapshot and args.backup_ref):
        raise SystemExit("--apply requires --snapshot and --backup-ref (take the DB backup first)")

    bucket = settings.GCS_BUCKET if args.bucket is None else args.bucket
    app_origins = None
    if args.app_origin:
        app_origins = frozenset(filter(None, map(normalize_origin, args.app_origin)))
    discovery = await discover(
        session_factory, bucket=bucket, app_origins=app_origins, batch_size=args.batch_size
    )
    _print_report(discovery, apply=args.apply)
    if args.preview:
        Path(args.preview).write_text("".join(json.dumps(asdict(c)) + "\n" for c in discovery.changes))
    if not args.apply:
        return 0

    write_snapshot(args.snapshot, discovery.changes, backup_ref=args.backup_ref)
    print(f"snapshot written: {args.snapshot}")
    result = await apply_changes(session_factory, discovery.changes, batch_size=args.batch_size)
    print(f"applied: {result.applied}, skipped (edited mid-run): {result.skipped}")
    return 0


def main() -> None:
    args = parse_args()
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _run() -> int:
        try:
            return await run(args, session_factory)
        finally:
            await engine.dispose()

    sys.exit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
