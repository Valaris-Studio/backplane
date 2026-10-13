# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import database
from app.core.auth import current_agent_id
from app.core.event_bus import event_bus
from app.core.workspace import enforce_agent_scope
from app.exceptions import (
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
    ValarisError,
)
from app.models.agents.agent import Agent
from app.models.timeline import TimelineGeneration, TimelinePreparation
from app.models.workspace import Workspace
from app.repositories.timeline import TimelineRepository
from app.services.activity import ActivityService
from app.services.timeline_replay import fold_events

logger = logging.getLogger(__name__)
INLINE_REPLAY_LIMIT = 200
GENERATION_LIFETIME = timedelta(hours=24)
MAX_SEQUENCE = 2**63 - 1


class GenerationExpired(ValarisError):
    status_code = 410
    error_code = "timeline_generation_expired"
    detail = "This history view has expired. Open a new generation."


def now():
    return datetime.now(timezone.utc)


def utc(value):
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def sequence(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value)
        or int(value) > MAX_SEQUENCE
    ):
        raise ValidationError("Invalid history sequence")
    return int(value)


def initial_anchor(generation):
    known = generation.known_empty_genesis
    return {
        "through_seq": None,
        "state": {"columns": [], "cards": []},
        "coverage": {
            "quality": "reconstructed" if known else "partial",
            "unknown_origin": not known,
            "missing_structural_snapshots": "0",
            "reasons": [] if known else ["unknown_origin"],
        },
    }


def checkpoint_anchor(checkpoint):
    return {
        "through_seq": str(checkpoint.through_seq),
        "state": checkpoint.state,
        "coverage": checkpoint.coverage,
    }


def generation_read(generation):
    return {
        "id": str(generation.id),
        "board_id": str(generation.board_id),
        "created_at": utc(generation.created_at),
        "expires_at": utc(generation.expires_at),
        "first_seq": str(generation.first_seq)
        if generation.first_seq is not None
        else None,
        "head_seq": str(generation.head_seq)
        if generation.head_seq is not None
        else None,
        "event_count": str(generation.event_count),
    }


def event_read(row, actor_labels=None):
    # Labels describe the generation observation; replay snapshots stay source data.
    try:
        agent_id = str(uuid.UUID(row.principal_key)) if row.principal_key else None
    except ValueError:
        agent_id = None
    # Legacy FK provenance is best effort; NULL never establishes a human actor.
    if agent_id is None and row.principal_key is None and row.agent_id is not None:
        agent_id = str(row.agent_id)
    actor_name = (actor_labels or {}).get(str(row.actor_id), {}).get("name")
    return {
        "id": str(row.id),
        "workspace_id": str(row.workspace_id),
        "board_id": str(row.board_id),
        "seq": str(row.seq),
        "entity_type": row.entity_type.value,
        "entity_id": str(row.entity_id),
        "action": row.action.value,
        "actor_id": str(row.actor_id),
        "actor_name": actor_name,
        "actor_email": None,
        "agent_id": agent_id,
        "summary": row.summary,
        "message_key": row.message_key,
        "message_params": row.message_params,
        "changes": row.changes,
        "before_state": row.before_state,
        "after_state": row.after_state,
        "via_api_key": row.via_api_key,
        "created_at": utc(row.created_at).isoformat(),
        "entity_title": None,
    }


def preparation_read(work):
    return {
        "status": "failed" if work.status == "failed" else "preparing",
        "generation_id": str(work.generation_id),
        "preparation_id": str(work.id),
        "progress": {
            "through_seq": str(work.through_seq) if work.through_seq else None,
            "target_seq": str(work.target_seq),
            "processed_events": str(work.processed_events),
        },
        "retryable": work.retryable,
        "error": work.error,
    }


class TimelineService:
    def __init__(self, db):
        self.db = db
        self.repo = TimelineRepository(db)

    async def authorize(self, slug, board_id, user_id, agent_id=None):
        workspace = await self.repo.workspace(slug)
        if workspace is None:
            raise ResourceNotFoundError("Workspace not found")
        if await self.repo.membership(workspace.id, user_id) is None:
            raise ForbiddenError("Not a member of this workspace")
        if agent_id is not None:
            agent = await self.db.get(Agent, agent_id)
            if agent is None or not agent.is_active:
                raise ForbiddenError("Runner is no longer active")
        await enforce_agent_scope(agent_id, slug, self.db)
        board = await self.repo.board(workspace.id, board_id)
        if board is None:
            raise ResourceNotFoundError("Board not found")
        return board

    @classmethod
    async def establish(cls, slug, board_id, user_id, request_id):
        # A separate session avoids both an already-open request transaction and
        # stale objects in its identity map. The service owns this transaction.
        for attempt in range(2):
            try:
                async with database.async_session() as db:
                    async with db.begin():
                        if db.bind.dialect.name == "postgresql":
                            await db.connection(
                                execution_options={"isolation_level": "REPEATABLE READ"}
                            )
                        service = cls(db)
                        board = await service.authorize(
                            slug, board_id, user_id, current_agent_id.get()
                        )
                        existing = await service.repo.generation(
                            board.id, request_id=request_id
                        )
                        if existing is not None:
                            service.check_expiry(existing)
                            return generation_read(existing), False
                        snapshot = await service.repo.source_snapshot(board.id)
                        (
                            first,
                            head,
                            count,
                            first_at,
                            last_at,
                        ) = await service.repo.bounds(board.id)
                        baseline = await ActivityService(db).build_board_baseline(
                            board.id
                        )
                        created_at = now()
                        generation = TimelineGeneration(
                            id=uuid.uuid4(),
                            workspace_id=board.workspace_id,
                            board_id=board.id,
                            request_id=request_id,
                            created_at=created_at,
                            expires_at=created_at + GENERATION_LIFETIME,
                            first_seq=first,
                            head_seq=head,
                            event_count=count,
                            first_at=utc(first_at) if first_at else None,
                            last_at=utc(last_at) if last_at else None,
                            source_snapshot=snapshot,
                            observed_state=baseline.model_dump(mode="json")
                            if baseline
                            else {"columns": [], "cards": []},
                            cursor_secret=secrets.token_hex(32),
                            schema_version=1,
                        )
                        generation.known_empty_genesis = (
                            await service.repo.known_empty_genesis(generation)
                        )
                        generation.actor_labels = await service.repo.actor_labels(
                            generation
                        )
                        db.add(generation)
                        await db.flush()
                        result = generation_read(generation)
                    return result, True
            except IntegrityError:
                if attempt:
                    raise
        raise RuntimeError("Unable to establish generation")

    @staticmethod
    def check_expiry(generation):
        if utc(generation.expires_at) <= now():
            raise GenerationExpired()

    async def get(self, slug, board_id, user_id, generation_id, *, lock=False):
        board = await self.authorize(slug, board_id, user_id, current_agent_id.get())
        generation = await self.repo.generation(
            board.id, generation_id=generation_id, lock=lock
        )
        if generation is None:
            raise ResourceNotFoundError("History generation not found")
        self.check_expiry(generation)
        return generation

    def cursor(self, generation, purpose, boundary, direction="next", query=None):
        payload = {
            "v": 1,
            "board": str(generation.board_id),
            "generation": str(generation.id),
            "purpose": purpose,
            "boundary": str(boundary),
            "direction": direction,
        }
        if query is not None:
            payload["query"] = hashlib.sha256(query.encode()).hexdigest()
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(
            bytes.fromhex(generation.cursor_secret), raw, hashlib.sha256
        ).digest()
        return base64.urlsafe_b64encode(raw + signature).decode().rstrip("=")

    def parse_cursor(self, generation, token, purpose, query=None):
        try:
            if len(token) > 2048:
                raise ValueError()
            decoded = base64.b64decode(
                token + "=" * (-len(token) % 4), altchars=b"-_", validate=True
            )
            raw, signature = decoded[:-32], decoded[-32:]
            payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get("v") != 1:
                raise ValueError()
            if (
                payload.get("board") != str(generation.board_id)
                or payload.get("generation") != str(generation.id)
                or payload.get("purpose") != purpose
            ):
                raise ResourceNotFoundError("History cursor not found")
            expected = hmac.new(
                bytes.fromhex(generation.cursor_secret), raw, hashlib.sha256
            ).digest()
            if not hmac.compare_digest(signature, expected) or payload.get(
                "direction"
            ) not in ("next", "previous"):
                raise ValueError()
            if (
                query is not None
                and payload.get("query") != hashlib.sha256(query.encode()).hexdigest()
            ):
                raise ValueError()
            return sequence(payload.get("boundary")), payload["direction"]
        except (ValueError, TypeError, KeyError, UnicodeDecodeError):
            raise ValidationError("Invalid history cursor") from None

    async def live_head(self, generation):
        return {
            "generation_id": str(generation.id),
            "observed_at": utc(generation.created_at),
            "head_seq": str(generation.head_seq)
            if generation.head_seq is not None
            else None,
            "state": await self.repo.observed_state(generation.id),
        }

    async def overview(self, generation, buckets):
        return {
            "generation_id": str(generation.id),
            "first_seq": str(generation.first_seq)
            if generation.first_seq is not None
            else None,
            "head_seq": str(generation.head_seq)
            if generation.head_seq is not None
            else None,
            "first_at": utc(generation.first_at) if generation.first_at else None,
            "last_at": utc(generation.last_at) if generation.last_at else None,
            "event_count": str(generation.event_count),
            "buckets": await self.repo.overview(generation, buckets),
        }

    async def anchor(self, generation, target, user_id):
        if not target:
            return initial_anchor(generation), None
        checkpoint = await self.repo.checkpoint(generation.id, target)
        for candidate, source in await self.repo.reusable_checkpoints(
            generation, target
        ):
            if (
                checkpoint is not None
                and checkpoint.through_seq >= candidate.through_seq
            ):
                break
            if await self.repo.prefix_unchanged(
                source, generation, candidate.through_seq
            ):
                checkpoint = await self.repo.save_checkpoint(
                    generation.id,
                    candidate.through_seq,
                    candidate.processed_events,
                    {"state": candidate.state, "coverage": candidate.coverage},
                )
                break
        if checkpoint is not None and checkpoint.through_seq == target:
            return checkpoint_anchor(checkpoint), None
        work = await self.repo.preparation(generation.id, target=target)
        if work is not None:
            if work.status == "ready":
                # Its completed anchor may have been evicted by the bounded cache.
                work.status = "preparing"
                work.through_seq = checkpoint.through_seq if checkpoint else 0
                work.processed_events = checkpoint.processed_events if checkpoint else 0
                work.updated_at = now()
            return None, work
        start = checkpoint.through_seq if checkpoint else 0
        rows = await self.repo.page(
            generation, after=start, before=target + 1, limit=INLINE_REPLAY_LIMIT + 1
        )
        if len(rows) <= INLINE_REPLAY_LIMIT:
            anchor = (
                checkpoint_anchor(checkpoint)
                if checkpoint
                else initial_anchor(generation)
            )
            result = fold_events(
                [event_read(row) for row in rows], anchor["state"], anchor["coverage"]
            )
            if len(rows) == INLINE_REPLAY_LIMIT:
                await self.repo.save_checkpoint(
                    generation.id,
                    target,
                    (checkpoint.processed_events if checkpoint else 0) + len(rows),
                    result,
                )
            return {"through_seq": str(target), **result}, None
        work = TimelinePreparation(
            generation_id=generation.id,
            requested_by=user_id,
            agent_id=current_agent_id.get(),
            target_seq=target,
            through_seq=start,
            processed_events=checkpoint.processed_events if checkpoint else 0,
            status="preparing",
            retryable=True,
            error=None,
            updated_at=now(),
        )
        self.db.add(work)
        await self.db.flush()
        return None, work

    async def window(
        self, generation, user_id, *, limit=200, at_seq=None, at_time=None, cursor=None
    ):
        if sum(value is not None for value in (at_seq, at_time, cursor)) > 1:
            raise ValidationError("Choose one history selector")
        if cursor is not None:
            boundary, direction = self.parse_cursor(generation, cursor, "window")
            rows = await self.repo.page(
                generation,
                limit=limit,
                before=boundary if direction == "previous" else None,
                after=boundary if direction == "next" else None,
                descending=direction == "previous",
            )
        elif at_seq is not None or at_time is not None:
            target = await self.repo.seek(
                generation,
                seq=sequence(at_seq) if at_seq is not None else None,
                at_time=at_time,
            )
            rows = await self.repo.page(generation, limit=limit, start=target)
        else:
            rows = await self.repo.page(generation, limit=limit, descending=True)
        if not rows:
            return {
                "status": "ready",
                "generation_id": str(generation.id),
                "anchor": initial_anchor(generation),
                "events": [],
                "window": {
                    "first_seq": None,
                    "last_seq": None,
                    "previous_cursor": None,
                    "next_cursor": None,
                },
                "coverage": initial_anchor(generation)["coverage"],
            }
        previous = await self.repo.predecessor(generation, rows[0].seq)
        following = await self.repo.successor(generation, rows[-1].seq)
        anchor, work = await self.anchor(generation, previous, user_id)
        if work is not None:
            return preparation_read(work)
        events = [event_read(row, generation.actor_labels) for row in rows]
        coverage = fold_events(events, anchor["state"], anchor["coverage"])["coverage"]
        return {
            "status": "ready",
            "generation_id": str(generation.id),
            "anchor": anchor,
            "events": events,
            "coverage": coverage,
            "window": {
                "first_seq": str(rows[0].seq),
                "last_seq": str(rows[-1].seq),
                "previous_cursor": self.cursor(
                    generation, "window", rows[0].seq, "previous"
                )
                if previous is not None
                else None,
                "next_cursor": self.cursor(generation, "window", rows[-1].seq)
                if following is not None
                else None,
            },
        }

    async def search(self, generation, query, limit, cursor):
        query = query.strip()
        if not query:
            raise ValidationError("Enter a history search query")
        after = (
            self.parse_cursor(generation, cursor, "search", query)[0]
            if cursor
            else None
        )
        rows = await self.repo.search(generation, query, limit + 1, after)
        more = len(rows) > limit
        rows = rows[:limit]
        return {
            "generation_id": str(generation.id),
            "scope": "generation",
            "matches": [
                {
                    "id": str(row.id),
                    "seq": str(row.seq),
                    "created_at": utc(row.created_at),
                    "summary": row.summary,
                }
                for row in rows
            ],
            "next_cursor": self.cursor(generation, "search", rows[-1].seq, query=query)
            if more
            else None,
        }

    async def retry(self, generation, preparation_id):
        work = await self.repo.preparation(generation.id, preparation_id=preparation_id)
        if work is None:
            raise ResourceNotFoundError("History preparation not found")
        if work.status == "failed" and work.retryable:
            work.status = "preparing"
            work.error = None
            work.updated_at = now()
        return preparation_read(work)


async def process_pending_timeline_preparations(*, batch_size=250, max_jobs=4):
    if not 1 <= batch_size <= 500 or not 1 <= max_jobs <= 16:
        raise ValueError("History work batch is outside its bound")
    completed = 0
    for _ in range(max_jobs):
        work_id = None
        through_seq = None
        workspace_id = None
        generation_id = None
        board_id = None
        try:
            async with database.async_session() as db:
                async with db.begin():
                    service = TimelineService(db)
                    await service.repo.cleanup_expired(now())
                    work = await service.repo.pending(now())
                    if work is None:
                        break
                    work_id, through_seq = work.id, work.through_seq
                    generation = await db.get(TimelineGeneration, work.generation_id)
                    generation_id, workspace_id = generation.id, generation.workspace_id
                    board_id = generation.board_id
                    workspace = await db.get(Workspace, workspace_id)
                    await service.authorize(
                        workspace.slug,
                        generation.board_id,
                        work.requested_by,
                        work.agent_id,
                    )
                    service.check_expiry(generation)
                    checkpoint = await service.repo.checkpoint(
                        generation.id, work.through_seq
                    )
                    anchor = (
                        checkpoint_anchor(checkpoint)
                        if checkpoint
                        else initial_anchor(generation)
                    )
                    # A dormant job can outlive its cached anchor. Resume from
                    # actual retained evidence, never skip an evicted prefix.
                    start = checkpoint.through_seq if checkpoint else 0
                    work.processed_events = (
                        checkpoint.processed_events if checkpoint else 0
                    )
                    rows = await service.repo.page(
                        generation,
                        after=start,
                        before=work.target_seq + 1,
                        limit=batch_size,
                    )
                    result = fold_events(
                        [event_read(row) for row in rows],
                        anchor["state"],
                        anchor["coverage"],
                    )
                    boundary = rows[-1].seq if rows else work.target_seq
                    work.processed_events += len(rows)
                    await service.repo.save_checkpoint(
                        generation.id, boundary, work.processed_events, result
                    )
                    work.through_seq = boundary
                    work.updated_at = now()
                    if boundary >= work.target_seq:
                        work.status = "ready"
                    completed += 1
        except Exception as exc:
            if work_id is None:
                raise
            logger.exception("Timeline preparation failed: %s", work_id)
            async with database.async_session() as db:
                async with db.begin():
                    work = await db.scalar(
                        select(TimelinePreparation)
                        .where(TimelinePreparation.id == work_id)
                        .with_for_update()
                    )
                    if (
                        work is not None
                        and work.through_seq == through_seq
                        and work.status == "preparing"
                    ):
                        work.status = "failed"
                        work.retryable = not isinstance(
                            exc,
                            (ForbiddenError, ResourceNotFoundError, GenerationExpired),
                        )
                        work.error = {
                            "code": "history_preparation_failed"
                            if work.retryable
                            else "history_preparation_unavailable",
                            "message": "History preparation could not complete. Retry to continue."
                            if work.retryable
                            else "History preparation is no longer available.",
                        }
                        work.updated_at = now()
        if work_id is not None:
            try:
                await event_bus.publish(
                    event_type="timeline.preparation.updated",
                    workspace_id=workspace_id,
                    payload={
                        "board_id": str(board_id),
                        "generation_id": str(generation_id),
                        "preparation_id": str(work_id),
                    },
                )
            except Exception:
                logger.exception("Unable to publish timeline preparation progress")
    return completed
