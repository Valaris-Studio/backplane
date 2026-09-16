# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Server-side search / pagination / sort / filter for the notes list endpoints.

Covers BOTH list routes (workspace-level and board-level) — they share one
service+repository query path, so the same matrix has to hold on each.

The hard constraint threaded through every test here: a param-less call must
return exactly what it returned before this feature existed, for existing REST
clients. The MCP `list_notes` tool now always requests a bounded page.
"""
import json
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

WS_URL = "/api/workspaces/default/notes"


def board_url(board: Board) -> str:
    return f"/api/workspaces/default/boards/{board.id}/notes"


def pm_doc(*paragraphs: str) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": p}]}
                for p in paragraphs
            ],
        }
    )


async def make_note(
    db: AsyncSession,
    workspace: Workspace,
    *,
    title: str,
    body: str = "",
    created_by: uuid.UUID,
    board_id: uuid.UUID | None = None,
    pinned: bool = False,
    kind: str = "user_note",
    content_text: str | None = "__derive__",
) -> Note:
    """Insert a note directly, bypassing the service — models the rows that
    already exist in the DB. `content_text=None` models a row written by
    pre-migration code during a rolling deploy."""
    content = pm_doc(body) if body else ""
    kwargs = dict(
        workspace_id=workspace.id,
        board_id=board_id,
        title=title,
        content=content,
        pinned=pinned,
        kind=kind,
        created_by=created_by,
    )
    if content_text == "__derive__":
        from app.services.notes.content_text import extract_plain_text

        kwargs["content_text"] = extract_plain_text(content)
    else:
        kwargs["content_text"] = content_text
    note = Note(**kwargs)
    db.add(note)
    await db.flush()
    return note


# --- MCP compatibility: the param-less response must not change -------------


async def test_paramless_workspace_list_shape_unchanged(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="A", body="alpha", created_by=test_user.id)
    await make_note(db_session, test_workspace, title="B", body="beta", created_by=test_user.id)

    response = await client.get(WS_URL)
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    # Full NoteRead rows, `content` present, no envelope, no pagination header.
    assert all("content" in n for n in body)
    assert "X-Total-Count" not in response.headers
    assert set(body[0]) == {
        "id", "workspace_id", "board_id", "card_id", "title", "content",
        "pinned", "kind", "failure_class", "findings", "source_execution_id",
        "created_by", "created_at", "updated_at",
    }


async def test_paramless_board_list_shape_unchanged(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User
):
    await make_note(
        db_session, test_workspace, title="A", body="alpha",
        created_by=test_user.id, board_id=test_board.id,
    )
    response = await client.get(board_url(test_board))
    assert response.status_code == 200
    assert "content" in response.json()[0]
    assert "X-Total-Count" not in response.headers


async def test_paramless_list_is_unbounded(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """No implicit page size — an MCP call that expects everything gets it."""
    for i in range(25):
        await make_note(db_session, test_workspace, title=f"N{i:02d}", created_by=test_user.id)
    response = await client.get(WS_URL)
    assert len(response.json()) == 25


async def test_paramless_ordering_unchanged_pinned_then_created_desc(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Legacy default: pinned first, then newest-created. Preserved exactly."""
    import datetime as dt

    # Explicit timestamps: rows inserted in one test run share a created_at to
    # the microsecond, so a bare insert order proves nothing about the sort.
    for i, title in enumerate(("old", "mid", "new")):
        note = await make_note(db_session, test_workspace, title=title, created_by=test_user.id)
        note.created_at = dt.datetime(2026, 1, i + 1, 12, 0, 0)
    pinned = await make_note(
        db_session, test_workspace, title="pinned", created_by=test_user.id, pinned=True
    )
    pinned.created_at = dt.datetime(2025, 1, 1, 12, 0, 0)
    await db_session.flush()

    titles = [n["title"] for n in (await client.get(WS_URL)).json()]
    # Pinned wins despite being the OLDEST — that's the legacy contract.
    assert titles[0] == "pinned"
    assert titles[1:] == ["new", "mid", "old"]


# --- summary_only + preview -------------------------------------------------


async def test_summary_only_includes_preview(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(
        db_session, test_workspace, title="With body",
        body="The quick brown fox", created_by=test_user.id,
    )
    response = await client.get(WS_URL, params={"summary_only": "true"})
    assert response.status_code == 200
    row = response.json()[0]
    assert row["preview"] == "The quick brown fox"
    assert "content" not in row


async def test_preview_strips_markup_and_truncates(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(
        db_session, test_workspace, title="Long", body="y" * 500, created_by=test_user.id
    )
    row = (await client.get(WS_URL, params={"summary_only": "true"})).json()[0]
    assert row["preview"] == "y" * 200
    assert "{" not in row["preview"]


async def test_preview_falls_back_when_content_text_null(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Rolling deploy: new code reading a row old code wrote."""
    await make_note(
        db_session, test_workspace, title="Legacy", body="extracted on the fly",
        created_by=test_user.id, content_text=None,
    )
    row = (await client.get(WS_URL, params={"summary_only": "true"})).json()[0]
    assert row["preview"] == "extracted on the fly"


async def test_note_read_has_no_preview_field(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """NoteRead is unchanged — preview lives only on the summary schema."""
    await make_note(db_session, test_workspace, title="A", body="x", created_by=test_user.id)
    assert "preview" not in (await client.get(WS_URL)).json()[0]


# --- q: search across title and body ----------------------------------------


async def test_q_matches_title_only_note(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="Deployment runbook", body="unrelated", created_by=test_user.id)
    await make_note(db_session, test_workspace, title="Other", body="unrelated", created_by=test_user.id)

    rows = (await client.get(WS_URL, params={"q": "runbook"})).json()
    assert [r["title"] for r in rows] == ["Deployment runbook"]


async def test_q_matches_body_only_note(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="Meeting", body="we discussed the migration plan", created_by=test_user.id)
    await make_note(db_session, test_workspace, title="Other", body="nothing here", created_by=test_user.id)

    rows = (await client.get(WS_URL, params={"q": "migration"})).json()
    assert [r["title"] for r in rows] == ["Meeting"]


async def test_q_is_case_insensitive(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="PostgreSQL Tuning", body="VACUUM settings", created_by=test_user.id)

    assert len((await client.get(WS_URL, params={"q": "postgresql"})).json()) == 1
    assert len((await client.get(WS_URL, params={"q": "vacuum"})).json()) == 1
    assert len((await client.get(WS_URL, params={"q": "TUNING"})).json()) == 1


async def test_q_substring_matches_midword(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="Kubernetes", created_by=test_user.id)
    assert len((await client.get(WS_URL, params={"q": "bernet"})).json()) == 1


async def test_q_does_not_match_json_syntax(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Searching the raw content column would make every note match 'paragraph'."""
    await make_note(db_session, test_workspace, title="A", body="hello", created_by=test_user.id)
    assert (await client.get(WS_URL, params={"q": "paragraph"})).json() == []


async def test_q_searches_null_content_text_rows_via_fallback_or_skips_safely(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """A NULL content_text row must still be matchable by TITLE (the body may
    legitimately be unsearchable until the backfill runs)."""
    await make_note(
        db_session, test_workspace, title="Unmigrated runbook", body="hidden body",
        created_by=test_user.id, content_text=None,
    )
    rows = (await client.get(WS_URL, params={"q": "runbook"})).json()
    assert len(rows) == 1


async def test_q_respects_workspace_scoping(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner))
    await db_session.flush()

    await make_note(db_session, test_workspace, title="mine secret", created_by=test_user.id)
    await make_note(db_session, other_ws, title="theirs secret", created_by=test_user.id)

    rows = (await client.get(WS_URL, params={"q": "secret"})).json()
    assert [r["title"] for r in rows] == ["mine secret"]


async def test_q_respects_board_scoping(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User
):
    await make_note(db_session, test_workspace, title="board target", created_by=test_user.id, board_id=test_board.id)
    await make_note(db_session, test_workspace, title="workspace target", created_by=test_user.id)

    board_rows = (await client.get(board_url(test_board), params={"q": "target"})).json()
    assert [r["title"] for r in board_rows] == ["board target"]

    ws_rows = (await client.get(WS_URL, params={"q": "target"})).json()
    assert [r["title"] for r in ws_rows] == ["workspace target"]


# --- pagination + X-Total-Count ---------------------------------------------


async def test_limit_and_offset_page_through(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    for i in range(10):
        await make_note(db_session, test_workspace, title=f"N{i:02d}", created_by=test_user.id)

    page1 = await client.get(WS_URL, params={"limit": 4, "order_by": "title", "direction": "asc"})
    assert [r["title"] for r in page1.json()] == ["N00", "N01", "N02", "N03"]

    page2 = await client.get(WS_URL, params={"limit": 4, "offset": 4, "order_by": "title", "direction": "asc"})
    assert [r["title"] for r in page2.json()] == ["N04", "N05", "N06", "N07"]

    page3 = await client.get(WS_URL, params={"limit": 4, "offset": 8, "order_by": "title", "direction": "asc"})
    assert [r["title"] for r in page3.json()] == ["N08", "N09"]


async def test_total_count_header_present_when_limit_passed(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    for i in range(7):
        await make_note(db_session, test_workspace, title=f"N{i}", created_by=test_user.id)

    response = await client.get(WS_URL, params={"limit": 3})
    assert response.headers["X-Total-Count"] == "7"
    assert len(response.json()) == 3


async def test_total_count_reflects_q_before_paging(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """The owner's requirement: search spans ALL pages, so the total is the
    count of MATCHES, not the count of rows in the workspace."""
    for i in range(6):
        await make_note(db_session, test_workspace, title=f"match {i}", created_by=test_user.id)
    for i in range(4):
        await make_note(db_session, test_workspace, title=f"other {i}", created_by=test_user.id)

    response = await client.get(WS_URL, params={"q": "match", "limit": 2})
    assert response.headers["X-Total-Count"] == "6"
    assert len(response.json()) == 2
    assert all("match" in r["title"] for r in response.json())


async def test_offset_past_end_returns_empty_with_honest_total(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="only", created_by=test_user.id)
    response = await client.get(WS_URL, params={"limit": 10, "offset": 50})
    assert response.json() == []
    assert response.headers["X-Total-Count"] == "1"


async def test_limit_bounds_enforced(
    client: AsyncClient, test_workspace: Workspace
):
    assert (await client.get(WS_URL, params={"limit": 0})).status_code == 422
    assert (await client.get(WS_URL, params={"limit": 201})).status_code == 422
    assert (await client.get(WS_URL, params={"offset": -1})).status_code == 422


async def test_board_list_pagination_and_header(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User
):
    for i in range(5):
        await make_note(
            db_session, test_workspace, title=f"B{i}",
            created_by=test_user.id, board_id=test_board.id,
        )
    response = await client.get(board_url(test_board), params={"limit": 2})
    assert len(response.json()) == 2
    assert response.headers["X-Total-Count"] == "5"


# --- order_by / direction ---------------------------------------------------


async def test_order_by_title_is_case_insensitive(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    for title in ("banana", "Apple", "cherry"):
        await make_note(db_session, test_workspace, title=title, created_by=test_user.id)

    asc = (await client.get(WS_URL, params={"order_by": "title", "direction": "asc"})).json()
    assert [r["title"] for r in asc] == ["Apple", "banana", "cherry"]

    desc = (await client.get(WS_URL, params={"order_by": "title", "direction": "desc"})).json()
    assert [r["title"] for r in desc] == ["cherry", "banana", "Apple"]


async def test_order_by_created_at(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    import datetime as dt

    for i, title in enumerate(("first", "second", "third")):
        note = await make_note(db_session, test_workspace, title=title, created_by=test_user.id)
        note.created_at = dt.datetime(2026, 1, i + 1, 12, 0, 0)
    await db_session.flush()

    asc = (await client.get(WS_URL, params={"order_by": "created_at", "direction": "asc"})).json()
    assert [r["title"] for r in asc] == ["first", "second", "third"]

    desc = (await client.get(WS_URL, params={"order_by": "created_at", "direction": "desc"})).json()
    assert [r["title"] for r in desc] == ["third", "second", "first"]


async def test_order_by_updated_at_is_the_default(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    import datetime as dt

    for i, title in enumerate(("stale", "fresh")):
        note = await make_note(db_session, test_workspace, title=title, created_by=test_user.id)
        note.updated_at = dt.datetime(2026, 1, i + 1, 12, 0, 0)
    await db_session.flush()

    # Explicit order_by opts OUT of the legacy pinned-first default.
    rows = (await client.get(WS_URL, params={"order_by": "updated_at"})).json()
    assert [r["title"] for r in rows] == ["fresh", "stale"]


async def test_order_by_author_uses_display_name(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Ordering must match what the UI shows (name || email), not the raw
    created_by UUID — otherwise 'sort by author' looks random."""
    zoe = User(email="aaa@valaris.dev", name="Zoe Zulu")
    amy = User(email="zzz@valaris.dev", name="Amy Alpha")
    db_session.add_all([zoe, amy])
    await db_session.flush()

    await make_note(db_session, test_workspace, title="by-zoe", created_by=zoe.id)
    await make_note(db_session, test_workspace, title="by-amy", created_by=amy.id)

    asc = (await client.get(WS_URL, params={"order_by": "author", "direction": "asc"})).json()
    assert [r["title"] for r in asc] == ["by-amy", "by-zoe"]

    desc = (await client.get(WS_URL, params={"order_by": "author", "direction": "desc"})).json()
    assert [r["title"] for r in desc] == ["by-zoe", "by-amy"]


async def test_order_by_author_falls_back_to_email_when_name_blank(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    named = User(email="zzz@valaris.dev", name="Mona Mid")
    nameless = User(email="aaa@valaris.dev", name="")
    db_session.add_all([named, nameless])
    await db_session.flush()

    await make_note(db_session, test_workspace, title="by-named", created_by=named.id)
    await make_note(db_session, test_workspace, title="by-nameless", created_by=nameless.id)

    asc = (await client.get(WS_URL, params={"order_by": "author", "direction": "asc"})).json()
    # "aaa@valaris.dev" (email fallback) sorts before "Mona Mid".
    assert [r["title"] for r in asc] == ["by-nameless", "by-named"]


async def test_invalid_order_by_rejected(client: AsyncClient, test_workspace: Workspace):
    assert (await client.get(WS_URL, params={"order_by": "content"})).status_code == 422
    assert (await client.get(WS_URL, params={"direction": "sideways"})).status_code == 422


# --- filters: pinned_only / authors / kinds ---------------------------------


async def test_pinned_only_filter(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="loose", created_by=test_user.id)
    await make_note(db_session, test_workspace, title="stuck", created_by=test_user.id, pinned=True)

    rows = (await client.get(WS_URL, params={"pinned_only": "true"})).json()
    assert [r["title"] for r in rows] == ["stuck"]


async def test_authors_filter_accepts_repeated_param(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    other = User(email="other2@valaris.dev", name="Other Two")
    third = User(email="third@valaris.dev", name="Third")
    db_session.add_all([other, third])
    await db_session.flush()

    await make_note(db_session, test_workspace, title="mine", created_by=test_user.id)
    await make_note(db_session, test_workspace, title="theirs", created_by=other.id)
    await make_note(db_session, test_workspace, title="thirds", created_by=third.id)

    single = (await client.get(WS_URL, params={"authors": str(other.id)})).json()
    assert [r["title"] for r in single] == ["theirs"]

    multi = await client.get(WS_URL, params=[("authors", str(other.id)), ("authors", str(third.id))])
    assert sorted(r["title"] for r in multi.json()) == ["theirs", "thirds"]


async def test_kinds_filter(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="prose", created_by=test_user.id, kind="user_note")
    await make_note(db_session, test_workspace, title="the plan", created_by=test_user.id, kind="plan")
    await make_note(db_session, test_workspace, title="brief", created_by=test_user.id, kind="rework_brief")

    rows = await client.get(WS_URL, params=[("kinds", "plan"), ("kinds", "rework_brief")])
    assert sorted(r["title"] for r in rows.json()) == ["brief", "the plan"]


# --- composition matrix -----------------------------------------------------


async def test_q_plus_author_plus_order_plus_offset_compose(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    author = User(email="composer@valaris.dev", name="Composer")
    db_session.add(author)
    await db_session.flush()

    # 5 matching notes by `author`, 3 by test_user, 2 non-matching by `author`.
    for i in range(5):
        await make_note(db_session, test_workspace, title=f"report {i}", created_by=author.id)
    for i in range(3):
        await make_note(db_session, test_workspace, title=f"report other {i}", created_by=test_user.id)
    for i in range(2):
        await make_note(db_session, test_workspace, title=f"memo {i}", created_by=author.id)

    response = await client.get(
        WS_URL,
        params=[
            ("q", "report"), ("authors", str(author.id)),
            ("order_by", "title"), ("direction", "asc"),
            ("limit", "2"), ("offset", "2"),
        ],
    )
    assert response.headers["X-Total-Count"] == "5"
    assert [r["title"] for r in response.json()] == ["report 2", "report 3"]


async def test_filters_compose_with_summary_only(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="keep", body="findable text", created_by=test_user.id, pinned=True)
    await make_note(db_session, test_workspace, title="drop", body="findable text", created_by=test_user.id)

    response = await client.get(
        WS_URL, params={"q": "findable", "pinned_only": "true", "summary_only": "true", "limit": 10}
    )
    rows = response.json()
    assert [r["title"] for r in rows] == ["keep"]
    assert rows[0]["preview"] == "findable text"
    assert response.headers["X-Total-Count"] == "1"


async def test_q_with_no_matches_returns_empty_and_zero_total(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await make_note(db_session, test_workspace, title="something", created_by=test_user.id)
    response = await client.get(WS_URL, params={"q": "zzzznotfound", "limit": 10})
    assert response.json() == []
    assert response.headers["X-Total-Count"] == "0"


async def test_card_id_filter_still_works_with_new_params(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_card, test_user: User
):
    linked = Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=test_card.id,
        title="card note", content=pm_doc("attached"), created_by=test_user.id,
        content_text="attached",
    )
    db_session.add(linked)
    await make_note(db_session, test_workspace, title="board note", created_by=test_user.id, board_id=test_board.id)
    await db_session.flush()

    rows = (await client.get(board_url(test_board), params={"card_id": str(test_card.id)})).json()
    assert [r["title"] for r in rows] == ["card note"]


# --- MCP URL replay ---------------------------------------------------------


async def test_mcp_list_notes_url_shapes(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_card, test_user: User
):
    """Replay the EXACT URLs `mcp-server/src/valaris_mcp/tools/notes.py`
    builds. That tool appends params only for `card_id` and `summary_only`, so
    these five shapes are the entire surface the MCP server can produce — each
    must still answer 200 with the row shape its callers parse."""
    await make_note(db_session, test_workspace, title="WS", body="ws body", created_by=test_user.id)
    await make_note(
        db_session, test_workspace, title="B", body="b body",
        created_by=test_user.id, board_id=test_board.id,
    )
    board_base = board_url(test_board)

    for url, expect_content in (
        (WS_URL, True),
        (f"{WS_URL}?summary_only=true", False),
        (board_base, True),
        (f"{board_base}?summary_only=true", False),
        (f"{board_base}?card_id={test_card.id}", True),
    ):
        response = await client.get(url)
        assert response.status_code == 200, url
        # Never an envelope — the tool does `json.dumps(result)` over an array.
        assert isinstance(response.json(), list), url
        # No pagination header leaks onto a call that didn't ask to page.
        assert "X-Total-Count" not in response.headers, url
        for row in response.json():
            assert ("content" in row) is expect_content, url
