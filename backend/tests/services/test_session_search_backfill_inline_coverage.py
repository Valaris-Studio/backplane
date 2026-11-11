# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent B01H inline/event budgets, current membership and scope coverage.

These fixtures retain real captured descriptors under historical identities.
The first diagnostic uses only landed B01; late driver import distinguishes an
absent implementation from a behavioral failure. Physical SQLite connections
prove sequential committed observations, not PostgreSQL lock-wait ordering.
"""

import hashlib
import importlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import LargeBinary, cast, delete, event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.sql import visitors
from sqlalchemy.sql.elements import Cast, Label, TypeCoerce
from sqlalchemy.sql.functions import FunctionElement

from app.models.agent_session import AgentSession, AgentSessionContent, AgentSessionEvent
from app.models.session_search import SessionSearchChunk, SessionSearchSource, SessionSearchState
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.session_search_index import SessionSearchIndexWriter
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration, sessions_path
from tests.services.test_session_search_backfill import (
    BodyIO,
    db_engine as physical_db_engine,
)
from tests.test_session_search import (
    capture as capture_fixture,
    exact_match,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
    store_contents,
)

db_engine = physical_db_engine
capture = capture_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

MARKER = "Straße_INLINE_HISTORY"
INLINE_TEXT = "先🙂 " + "ordinary " * 600 + MARKER + " fin"
BODY_COLUMNS = (
    AgentSessionContent.__table__.c.inline_text,
    AgentSessionEvent.__table__.c.event,
    SessionSearchChunk.__table__.c.folded_text,
)
SOURCE_TABLES = {"agent_session_contents", "agent_session_events"}


def _raw_body_column(expression):
    # Length/count expressions stay in the database. A projected raw column,
    # including a label or text cast of it, materializes the retained body.
    while isinstance(expression, (Label, Cast, TypeCoerce)):
        expression = (
            expression.element if isinstance(expression, Label) else expression.clause
        )
    return any(column in expression.proxy_set for column in BODY_COLUMNS)


class QueryObservation:
    """Transparent SQLAlchemy observations; never replace a query or its rows."""

    def __init__(self, engine):
        self.engine = engine.sync_engine
        self.rows = []
        event.listen(self.engine, "before_cursor_execute", self.observe)

    def observe(self, _connection, _cursor, _sql, _parameters, context, _many):
        statement = getattr(context.compiled, "statement", None)
        if statement is None or not getattr(statement, "is_select", False):
            return
        nodes = list(visitors.iterate(statement))
        tables = {
            node.name for node in nodes
            if getattr(node, "__visit_name__", None) == "table"
        }
        aggregates = {
            node.name.lower() for node in nodes
            if isinstance(node, FunctionElement) and node.name
            and node.name.lower() in {"sum", "count", "min", "max"}
        }
        self.rows.append({
            "tables": sorted(tables),
            "aggregate": bool(aggregates),
            "raw_body_projection": any(
                _raw_body_column(column) for column in statement.selected_columns
            ),
        })

    def clear(self):
        self.rows.clear()

    def close(self):
        event.remove(self.engine, "before_cursor_execute", self.observe)

    def assert_metadata_only(self):
        assert not any(row["raw_body_projection"] for row in self.rows), self.rows

    def aggregate_count(self):
        return sum(
            row["aggregate"] and bool(SOURCE_TABLES.intersection(row["tables"]))
            for row in self.rows
        )


class InlineCase:
    def __init__(self, db, factory, client, workspace, owner, template, session, io, queries):
        self.db = db
        self.factory = factory
        self.client = client
        self.workspace = workspace
        self.owner = owner
        self.template = template
        self.root = session
        self.io = io
        self.queries = queries
        self.evidence = {"observations": [], "passes": []}

    async def content(self, text=INLINE_TEXT, *, session=None, **changes):
        session = session or self.root
        identity = uuid.uuid4()
        body = text.encode() if text is not None else None
        values = {
            **self.template,
            "id": identity,
            "session_id": session.id,
            "workspace_id": session.workspace_id,
            "content_key": hashlib.sha256(identity.bytes).hexdigest(),
            "inline_text": text,
            "preview": None,
            "byte_count": len(body) if body is not None else None,
            "original_byte_count": None,
            "sha256": hashlib.sha256(body).hexdigest() if body is not None else None,
            **changes,
        }
        self.db.add(AgentSessionContent(**values))
        await self.db.commit()
        return identity

    async def stored_event(self, text="前🙂 EVENT_MARKER", *, session=None, extra=None):
        session = session or self.root
        identity = uuid.uuid4()
        self.db.add(AgentSessionEvent(
            id=identity, session_id=session.id,
            event_id=hashlib.sha256(identity.bytes).hexdigest(),
            capture_id=uuid.uuid4().hex,
            occurred_at=self.template["occurred_at"],
            received_at=self.template["received_at"],
            action="user.prompt", collection_method="hook",
            event={"prompt": {"text": text}, **(extra or {})},
        ))
        await self.db.commit()
        return identity

    async def workspace_with_session(self, *, member=True, parent=None, workspace=None):
        workspace = workspace or Workspace(
            id=uuid.uuid4(), name="Synthetic retained workspace",
            slug="retained-" + uuid.uuid4().hex, created_by=self.owner.id,
        )
        if workspace not in self.db:
            self.db.add(workspace)
            await self.db.flush()
            if member:
                self.db.add(WorkspaceMember(
                    workspace_id=workspace.id, user_id=self.owner.id,
                    role=WorkspaceRole.owner,
                ))
        session = AgentSession(
            id=uuid.uuid4(), workspace_id=workspace.id, owner_id=self.owner.id,
            installation_id=self.root.installation_id, harness=self.root.harness,
            native_session_id="synthetic-retained-" + uuid.uuid4().hex,
            parent_session_id=parent.id if parent else None,
            parent_native_session_id=parent.native_session_id if parent else None,
            started_at=self.root.started_at, last_event_at=self.root.last_event_at,
        )
        self.db.add(session)
        await self.db.commit()
        return workspace, session

    async def source(self, identity, kind="content"):
        column = SessionSearchSource.content_id if kind == "content" else SessionSearchSource.event_id
        async with self.factory.begin() as db:
            return await db.scalar(select(SessionSearchSource).where(column == identity))

    async def index_state(self):
        async with self.factory.begin() as db:
            return {
                "sources": await db.scalar(select(func.count()).select_from(SessionSearchSource)),
                "chunks": await db.scalar(select(func.count()).select_from(SessionSearchChunk)),
                "generation": await db.scalar(select(SessionSearchState.generation).where(
                    SessionSearchState.session_id == self.root.id
                )),
            }

    async def find(self, query=MARKER.casefold(), *, session=None, workspace=None):
        page = await search(
            self.client,
            sessions_path(workspace or self.workspace, (session or self.root).id),
            query,
        )
        await self.db.commit()
        return page

    def driver(self):
        module = importlib.import_module("app.services.session_search_backfill")
        return module.SessionSearchBackfillService(self.factory)

    def record(self, value):
        result = value.model_dump(mode="json", by_alias=True)
        assert result["schema"] == "session-search-backfill/1"
        return result

    async def start(self):
        self.io.clear()
        self.queries.clear()
        value = self.record(await self.driver().start_run(scope="all_workspaces"))
        self.queries.assert_metadata_only()
        assert self.io.stats == self.io.reads == []
        self.evidence["observations"].append({"stage": "start", "receipt": value})
        return value

    async def status(self, started):
        self.io.clear()
        self.queries.clear()
        value = self.record(await self.driver().status(uuid.UUID(started["run"]["id"])))
        self.queries.assert_metadata_only()
        assert self.io.stats == self.io.reads == []
        self.evidence["observations"].append({
            "stage": "status", "receipt": value, "queries": list(self.queries.rows),
        })
        return value

    async def step(self, started, byte_budget):
        self.io.clear()
        self.queries.clear()
        value = self.record(await self.driver().run_pass(
            uuid.UUID(started["run"]["id"]), source_limit=25, byte_budget=byte_budget,
        ))
        self.evidence["passes"].append({"receipt": value, "queries": list(self.queries.rows)})
        measured = value["pass"]
        assert measured["byte_budget"] == byte_budget
        assert 0 <= measured["sources_attempted"] <= 25
        assert 0 <= measured["candidate_keys_examined"] <= 200
        for name in ("reserved_bytes", "requested_bytes", "returned_bytes"):
            assert 0 <= measured[name] <= byte_budget, measured
        assert self.io.stats == self.io.reads == [], "Inline/event work must not access the object store"
        return value


@pytest.fixture
async def inline_case(
    client, device_client, db_session, db_engine, test_workspace, test_user,
    capture, monkeypatch, tmp_path, request,
):
    [ack] = await store_contents(device_client, capture, [declaration(b"real descriptor")])
    assert ack["outcome"] == "available", ack
    template = await db_session.get(AgentSessionContent, uuid.UUID(ack["content_id"]))
    values = {
        column.name: getattr(template, column.name)
        for column in AgentSessionContent.__table__.columns
    }
    for name in ("occurred_at", "observed_at", "received_at"):
        values[name] -= timedelta(days=90)
    session = await db_session.get(AgentSession, template.session_id)
    await db_session.delete(template)
    await db_session.commit()
    queries = QueryObservation(db_engine)
    case = InlineCase(
        db_session, async_sessionmaker(db_engine, expire_on_commit=False), client,
        test_workspace, test_user, values, session, BodyIO(monkeypatch), queries,
    )
    try:
        yield case
    finally:
        queries.close()
        case.evidence.update(
            test=request.node.name,
            test_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        )
        (tmp_path / "inline-coverage-regression-receipt.json").write_text(
            json.dumps(case.evidence, indent=2) + "\n"
        )


async def test_landed_inline_history_gap_and_exact_writer_search_control(inline_case):
    case = inline_case
    identity = await case.content()
    before = await case.find()
    assert before["items"] == []
    assert before["coverage"]["pending_index"] == {"count": 1, "bytes": len(INLINE_TEXT.encode())}
    case.evidence["observations"].append({"stage": "landed_historical_gap", "coverage": before["coverage"]})
    async with case.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_source("content", identity) == "indexed"
    after = await case.find()
    [item] = after["items"]
    assert item["content_id"] == str(identity)
    exact_match(item, INLINE_TEXT, MARKER)
    assert after["coverage"]["index_ready"] is True
    case.evidence["observations"].append({
        "stage": "landed_exact_writer_control", "byte_start": item["byte_start"],
        "byte_end": item["byte_end"], "coverage": after["coverage"],
    })


@pytest.mark.parametrize("legacy_size", [None, 1], ids=["unknown_size", "wrong_size"])
async def test_legacy_inline_size_cannot_bypass_actual_body_budget(inline_case, legacy_size):
    case = inline_case
    identity = await case.content(byte_count=legacy_size)
    before = await case.index_state()
    started = await case.start()
    # Too small even for the UTF-8 body, regardless of nullable/wrong metadata.
    for _ in range(4):
        value = await case.step(started, byte_budget=32)
        case.queries.assert_metadata_only()
        assert await case.source(identity) is None
        assert await case.index_state() == before
        assert value["coverage"]["pending_index"]["count"] == 1
        assert value["coverage"]["index_ready"] is False
        assert value["readiness"] != "ready_at_observation"
    # Ample budget must not turn invalid legacy metadata into invented text.
    # Rejection without materialization is also legitimate; B01's writer, if
    # reached, records unavailable/digest_mismatch rather than repairing it.
    value = await case.step(started, byte_budget=len(INLINE_TEXT.encode()) + 1)
    source = await case.source(identity)
    assert source is None or (source.status, source.reason) == ("unavailable", "digest_mismatch")
    assert (await case.find())["items"] == []
    assert value["progress"]["outcomes"]["indexed"] == 0
    assert value["readiness"] != "ready_at_observation"


async def test_valid_inline_reserves_utf8_bytes_then_searches_exact_body(inline_case):
    case = inline_case
    text = "🙂先" * 256 + MARKER
    identity = await case.content(text)
    started = await case.start()
    encoded_size = len(text.encode())
    assert len(text) < encoded_size
    before = await case.index_state()
    for _ in range(4):
        await case.step(started, byte_budget=len(text))
        case.queries.assert_metadata_only()
        assert await case.source(identity) is None
        assert await case.index_state() == before
    for _ in range(8):
        value = await case.step(started, byte_budget=encoded_size)
        if await case.source(identity) is not None:
            break
    else:
        pytest.fail("One valid retained inline source was not processed in eight bounded passes")
    assert (await case.source(identity)).status == "indexed"
    assert value["pass"]["reserved_bytes"] >= encoded_size
    [item] = (await case.find())["items"]
    exact_match(item, text, MARKER)


async def test_event_budget_counts_persisted_json_not_only_searchable_leaves(inline_case):
    case = inline_case
    text = "前🙂 EVENT_MARKER"
    identity = await case.stored_event(text, extra={"synthetic_ignored_payload": "🙂" * 512})
    async with case.factory.begin() as db:
        persisted_bytes = await db.scalar(select(func.length(cast(
            AgentSessionEvent.event, LargeBinary
        ))).where(AgentSessionEvent.id == identity))
    assert persisted_bytes > len(text.encode()) * 10
    case.evidence["observations"].append({
        "stage": "event_budget_precondition", "persisted_json_bytes": persisted_bytes,
        "searchable_leaf_bytes": len(text.encode()),
    })
    before = await case.index_state()
    started = await case.start()
    for _ in range(4):
        await case.step(started, byte_budget=len(text.encode()) + 1)
        case.queries.assert_metadata_only()
        assert await case.source(identity, "event") is None
        assert await case.index_state() == before
    for _ in range(8):
        value = await case.step(started, byte_budget=persisted_bytes)
        if await case.source(identity, "event") is not None:
            break
    else:
        pytest.fail("One retained event was not processed in eight adequately budgeted passes")
    assert (await case.source(identity, "event")).status == "indexed"
    assert value["pass"]["reserved_bytes"] >= persisted_bytes
    [item] = (await case.find("event_marker"))["items"]
    assert item["source_id"] == str(identity)
    assert item["event_id"] == hashlib.sha256(identity.bytes).hexdigest()
    exact_match(item, text, "EVENT_MARKER")


@pytest.mark.parametrize("kind", ["content", "event"])
async def test_membership_lost_after_start_prevents_body_read_and_settlement(inline_case, kind):
    case = inline_case
    identity = await (case.content() if kind == "content" else case.stored_event())
    started = await case.start()
    before = await case.index_state()
    await case.db.execute(delete(WorkspaceMember).where(
        WorkspaceMember.workspace_id == case.workspace.id,
        WorkspaceMember.user_id == case.owner.id,
    ))
    await case.db.commit()
    for _ in range(4):
        value = await case.step(started, byte_budget=67_108_864)
        case.queries.assert_metadata_only()
        assert await case.source(identity, kind) is None
        assert await case.index_state() == before
    assert value["coverage"]["owner_not_member_count"] == 1
    assert value["coverage"]["eligible_count"] == 0
    denied = await case.client.post(
        sessions_path(case.workspace, case.root.id) + "/search", json={"q": MARKER},
    )
    assert denied.status_code in {403, 404}
    await case.db.commit()


def assert_coverage(value, expected, *, eligible_count, children, excluded):
    coverage = value["coverage"]
    for name, bucket in expected.items():
        assert coverage[name] == bucket, (name, coverage)
    assert coverage["eligible_count"] == eligible_count
    assert coverage["child_metadata_count"] == children
    assert coverage["owner_not_member_count"] == excluded
    assert coverage["extractor_version"] == EXTRACTOR_VERSION
    assert coverage["index_ready"] is (expected["pending_index"]["count"] == 0)
    observed_from = datetime.fromisoformat(coverage["observed_from"].replace("Z", "+00:00"))
    observed_at = datetime.fromisoformat(coverage["observed_at"].replace("Z", "+00:00"))
    assert observed_from <= observed_at <= datetime.now(timezone.utc)


async def test_scope_coverage_is_one_fresh_aggregate_across_workspaces_and_children(inline_case):
    case = inline_case
    indexed_text = "indexed 🙂"
    indexed = await case.content(indexed_text)
    async with case.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_source("content", indexed) == "indexed"
    _, child = await case.workspace_with_session(workspace=case.workspace, parent=case.root)
    pending = await case.content("unknown bytes", session=child, byte_count=None)
    other_workspace, other_root = await case.workspace_with_session()
    pending_event = await case.stored_event(session=other_root)
    await case.content(None, session=other_root, media_type="image/png", byte_count=4,
                       sha256="a" * 64, delivery="upload")
    await case.content(None, session=other_root, state="pending", byte_count=7, delivery="upload")
    await case.content(None, session=other_root, state="recorded", coverage="withheld_by_policy",
                       byte_count=None, original_byte_count=None, delivery="none")
    await case.content(None, session=other_root, state="recorded", coverage="collection_failed",
                       original_byte_count=11, delivery="none")
    unavailable = await case.content("wrong digest!", session=other_root, sha256="b" * 64)
    assert len("wrong digest!".encode()) == 13
    async with case.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_source("content", unavailable) == "unavailable"
    _, excluded_root = await case.workspace_with_session(member=False)
    await case.content("excluded one", session=excluded_root)
    await case.content("excluded two", session=excluded_root)
    await case.stored_event(session=excluded_root)
    expected = {
        "indexed": {"count": 1, "bytes": len(indexed_text.encode())},
        "pending_index": {"count": 2, "bytes": None},
        "pending_upload": {"count": 1, "bytes": 7},
        "withheld": {"count": 1, "bytes": None},
        "uncaptured": {"count": 1, "bytes": 11},
        "unavailable": {"count": 1, "bytes": 13},
        "nontext": {"count": 1, "bytes": 4},
        "available": {"count": 4, "bytes": None},
        "eligible": {"count": 3, "bytes": None},
    }
    started = await case.start()
    assert_coverage(started, expected, eligible_count=3, children=1, excluded=3)
    assert case.queries.aggregate_count() == 1, case.queries.rows
    initial = await case.status(started)
    assert_coverage(initial, expected, eligible_count=3, children=1, excluded=3)
    assert case.queries.aggregate_count() == 1, case.queries.rows
    initial_query_count = len(case.queries.rows)
    assert initial["readiness"] != "ready_at_observation"
    # A fresh observation must change its denominator without a query per
    # session. Each new root has both content and an event, not empty metadata.
    for _ in range(24):
        _, extra = await case.workspace_with_session(workspace=other_workspace)
        await case.content("xx", session=extra)
        await case.stored_event("extra event", session=extra)
    expected["pending_index"]["count"] += 48
    expected["available"]["count"] += 24
    expected["eligible"]["count"] += 48
    grown = await case.status(started)
    assert_coverage(grown, expected, eligible_count=51, children=1, excluded=3)
    assert case.queries.aggregate_count() == 1, case.queries.rows
    assert len(case.queries.rows) == initial_query_count, case.queries.rows
    # Restore the small original authorized corpus: terminal history and
    # excluded source rows remain visible while B01's index_ready becomes true.
    await case.db.execute(delete(AgentSession).where(
        AgentSession.workspace_id == other_workspace.id,
        AgentSession.id != other_root.id,
    ))
    await case.db.execute(delete(AgentSessionContent).where(AgentSessionContent.id == pending))
    await case.db.execute(delete(AgentSessionEvent).where(AgentSessionEvent.id == pending_event))
    await case.db.commit()
    expected["pending_index"] = {"count": 0, "bytes": 0}
    expected["available"] = {"count": 3, "bytes": len(indexed_text.encode()) + 4 + 13}
    expected["eligible"] = {"count": 1, "bytes": len(indexed_text.encode())}
    current = await case.status(started)
    assert_coverage(current, expected, eligible_count=1, children=1, excluded=3)
    assert case.queries.aggregate_count() == 1, case.queries.rows
    assert current["coverage"]["index_ready"] is True
    assert current["readiness"] != "ready_at_observation", "A status aggregate is not a completed verification epoch"
