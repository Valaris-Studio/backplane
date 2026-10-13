# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Guarded-note HTTP fixture and observations of actual SQLite returned rows."""

import copy
import json
import uuid
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field

import pytest_asyncio
from sqlalchemy import delete, event, select

from app.models.notes.note import Note
from app.models.workspace_config import WorkspaceConfig
from tests.routers.agents.context_receipts_support import (
    STAMP,
    ReceiptCase,
    _receipt_case_fixture,  # noqa: F401
    sha256,
)

DEFAULT_POLICY = {
    "version": 1,
    "max_note_body_bytes": 1048576,
    "max_note_fetch_bytes": 2097152,
    "max_optional_note_bytes": 65536,
    "max_managed_context_bytes": 131072,
    "max_invocation_bytes": 262144,
}
NOTE_SOURCES = ("card_notes", "pinned_notes", "board_definition", "review_history")


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utf8(value):
    return len(value.encode("utf-8"))


def policy_digest(policy):
    return sha256("backplane.context-budget.v1\0" + compact_json(policy))


@dataclass
class BudgetCase:
    receipt: ReceiptCase
    execution: dict
    engine: object
    notes: list[dict] = field(default_factory=list)

    async def configure(self, sources, *, enforced=True, **limits):
        async with self.receipt.factory() as session:
            config = (await session.execute(select(WorkspaceConfig).where(
                WorkspaceConfig.workspace_id == uuid.UUID(self.receipt.workspace["id"]),
            ))).scalar_one()
            pipeline = copy.deepcopy(config.pipeline_config)
            pipeline["stages"][0]["llm"]["context_sources"] = sources
            if enforced:
                pipeline["context_budget"] = {**DEFAULT_POLICY, **limits}
            else:
                pipeline.pop("context_budget", None)
            config.pipeline_config = pipeline
            await session.commit()

    async def seed(self, specifications):
        added = []
        async with self.receipt.factory() as session:
            for specification in specifications:
                spec = dict(specification)
                number = spec.pop("number", len(self.notes) + len(added) + 1)
                scope = spec.pop("scope", "card")
                note = {
                    "id": str(uuid.UUID(int=1000 + number)),
                    "title": f"Evidence {number}", "content": f"Body {number} é🧭",
                    "kind": "user_note", "pinned": True,
                    "created_at": STAMP, "updated_at": STAMP,
                    **spec,
                }
                model = Note(
                    **{**note, "id": uuid.UUID(note["id"])},
                    workspace_id=uuid.UUID(self.receipt.workspace["id"]),
                    board_id=None if scope == "workspace" else uuid.UUID(self.receipt.board_id),
                    card_id=(uuid.UUID(self.receipt.card_id) if scope == "card" else
                             uuid.UUID(self.receipt.other_card_id) if scope == "other_card" else None),
                    created_by=uuid.UUID(self.receipt.recipient_id),
                    content_text="UNFETCHED_PROJECTION_" + note["id"],
                    findings=[{"message": "UNFETCHED_FINDINGS_" + note["id"]}],
                )
                session.add(model)
                added.append(note)
            await session.commit()
        self.notes.extend(added)
        return added

    async def refresh(self):
        return await self.receipt.http.get(
            self.receipt.execution_path(self.execution["id"]) + "/context",
            headers=self.receipt.headers["agent"],
        )


@pytest_asyncio.fixture(name="budget_case")
async def _budget_case_fixture(receipt_case, db_engine):
    execution = await receipt_case.start(await receipt_case.assignment())
    async with receipt_case.factory() as session:
        await session.execute(delete(Note).where(
            Note.workspace_id == uuid.UUID(receipt_case.workspace["id"]),
        ))
        await session.commit()
    return BudgetCase(receipt_case, execution, db_engine)


def source(kind="card_notes", alias="Contexté47", **options):
    return {"kind": kind, "as": alias, **options}


def note_for_source(kind, **options):
    return {
        "scope": "workspace" if kind == "pinned_notes" else "board" if kind == "board_definition" else "card",
        "kind": "review_verdict" if kind == "review_history" else "user_note",
        **options,
    }


def expected_block(note, kind="card_notes", *, kind_filter=False):
    # Deliberately independent formatting oracle for simple literal fixture bodies.
    if kind in {"pinned_notes", "board_definition"}:
        return f"NOTE — {note['title']}:\n{note['content']}"
    if kind == "review_history":
        return f"--- {note['title']} (created {note['created_at'].isoformat()}) ---\n{note['content']}"
    marker = "" if kind_filter else f"[{note['kind']}] "
    body = note["content"].strip()
    lines = "\n".join("  " + line if line else line for line in body.split("\n"))
    return f"- **{marker}{note['title']}**:" + ("\n\n" + lines if body else "")


@dataclass
class ReturnedNotes:
    body_reads: Counter = field(default_factory=Counter)
    header_ids: set = field(default_factory=set)
    header_row_count: int = 0
    projection_reads: list = field(default_factory=list)
    orm_loads: list = field(default_factory=list)
    observed_row_batches: int = 0


@contextmanager
def observe_notes(case):
    observation = ReturnedNotes()
    bodies = {note["content"]: note["id"] for note in case.notes}
    assert len(bodies) == len(case.notes), "Observation requires distinct synthetic body values"
    ids = {note["id"] for note in case.notes}

    def returned_rows(connection, cursor, statement, parameters, context, executemany):
        if cursor.description is None:
            return
        assert hasattr(cursor, "_rows"), "This transfer observer requires buffered aiosqlite rows"
        observation.observed_row_batches += 1
        for row in cursor._rows:
            strings = [value for value in row if isinstance(value, str)]
            transferred = [bodies[value] for value in strings if value in bodies]
            observation.body_reads.update(transferred)
            for value in strings:
                if "UNFETCHED_PROJECTION_" in value or "UNFETCHED_FINDINGS_" in value:
                    observation.projection_reads.append(value[:90])
                if not transferred and len(value) in (32, 36):
                    try:
                        note_id = str(uuid.UUID(value))
                    except ValueError:
                        continue
                    if note_id in ids:
                        observation.header_ids.add(note_id)
                        observation.header_row_count += 1

    def loaded(note, context):
        observation.orm_loads.append(str(note.id))

    event.listen(case.engine.sync_engine, "after_cursor_execute", returned_rows)
    event.listen(Note, "load", loaded)
    try:
        yield observation
    finally:
        event.remove(case.engine.sync_engine, "after_cursor_execute", returned_rows)
        event.remove(Note, "load", loaded)


def assert_guarded(observation, expected_notes):
    assert observation.observed_row_batches > 0
    assert observation.body_reads == Counter(note["id"] for note in expected_notes)
    assert observation.orm_loads == []
    assert observation.projection_reads == []


def assert_manifest(payload, policy=None, *, fetched, rendered):
    manifest = payload["context_manifest"]
    assert manifest["schema_version"] == 2
    assert manifest["renderer_version"] == "context-v1"
    effective = {**DEFAULT_POLICY, **(policy or {})}
    assert manifest["budget"] == {
        "policy": effective, "policy_sha256": policy_digest(effective),
        "raw_note_bytes_fetched": fetched, "managed_context_bytes": rendered,
        "raw_note_fetch_coverage": "complete", "non_note_fetch_coverage": "not_bounded",
    }
    return manifest
