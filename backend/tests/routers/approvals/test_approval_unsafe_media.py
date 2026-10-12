# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Approval rich text gets the same media-src allowlist as notes, cards and definitions.

`action_description`, `decision_reason` and `action_payload.details` render
through the rich-text renderer in the decide dialog — as ProseMirror JSON,
HTML or markdown — so an unsafe image/attachment/link URL
(`javascript:` and its obfuscations) must be stripped on every write path —
HTTP, which the MCP `request_approval`/`decide_approval` tools and the runner
both call — and never reach the API response, the event bus, or a later read.
"""

import html
import json
import re
import time
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.approvals.approval import ApprovalCategory, ApprovalRequest, ApprovalStatus
from app.models.workspace import Workspace
from app.utils import utcnow

BASE_URL = "/api/workspaces/default/approvals"
SAFE_SRC = "/api/workspaces/default/resources/44444444-4444-4444-8444-444444444444/content"

OBFUSCATED_JAVASCRIPT_SRCS = [
    pytest.param("javascript:alert(document.cookie)", id="javascript"),
    pytest.param("JaVaScRiPt:alert(1)", id="mixed-case"),
    pytest.param(" javascript:alert(1)", id="leading-space"),
    pytest.param("java\tscript:alert(1)", id="tab-inside-scheme"),
    pytest.param("java\nscript:alert(1)", id="newline-inside-scheme"),
    pytest.param("\x00javascript:alert(1)", id="leading-nul"),
    pytest.param("//evil.example/x.png", id="protocol-relative"),
    pytest.param("/\t/evil.example/x.png", id="tab-protocol-relative"),
    pytest.param("data:text/html;base64,PHNjcmlwdD4=", id="data"),
]


def _doc_with_unsafe_media(src: str) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Delete the backlog"}]},
                {"type": "fileAttachment", "attrs": {"src": src, "filename": "evil.pdf"}},
                {"type": "image", "attrs": {"src": src, "alt": "x"}},
                {"type": "image", "attrs": {"src": SAFE_SRC, "alt": "kept"}},
            ],
        }
    )


def _assert_stripped(stored: str) -> None:
    nodes = json.loads(stored)["content"]
    assert [node["type"] for node in nodes] == ["paragraph", "fileAttachment", "image"]
    assert nodes[1]["attrs"] == {"src": None, "filename": "evil.pdf"}
    assert nodes[2]["attrs"]["src"] == SAFE_SRC
    lowered = stored.lower()
    assert "script:" not in lowered and "evil.example" not in lowered and "data:" not in lowered


async def _create(client: AsyncClient, agent: Agent, description: str, payload: dict | None = None) -> dict:
    response = await client.post(
        BASE_URL,
        json={
            "agent_id": str(agent.id),
            "category": "deletion",
            "action_description": description,
            "action_payload": payload or {},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("src", OBFUSCATED_JAVASCRIPT_SRCS)
async def test_create_approval_strips_unsafe_media_from_action_description(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent, src: str
):
    created = await _create(client, test_agent, _doc_with_unsafe_media(src))

    _assert_stripped(created["action_description"])
    fetched = await client.get(f"{BASE_URL}/{created['id']}")
    _assert_stripped(fetched.json()["action_description"])
    listed = await client.get(BASE_URL)
    [row] = [a for a in listed.json() if a["id"] == created["id"]]
    _assert_stripped(row["action_description"])


@pytest.mark.parametrize("src", OBFUSCATED_JAVASCRIPT_SRCS)
async def test_decide_approval_strips_unsafe_media_from_decision_reason(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent, src: str
):
    created = await _create(client, test_agent, "Delete 12 cards")
    assert created["status"] == "pending"

    decided = await client.post(
        f"{BASE_URL}/{created['id']}/decide",
        json={"decision": "rejected", "reason": _doc_with_unsafe_media(src)},
    )

    assert decided.status_code == 200, decided.text
    _assert_stripped(decided.json()["decision_reason"])
    fetched = await client.get(f"{BASE_URL}/{created['id']}")
    _assert_stripped(fetched.json()["decision_reason"])


async def test_approval_events_carry_the_stripped_rich_text(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent
):
    with patch("app.services.approvals.approval.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        created = await _create(client, test_agent, _doc_with_unsafe_media("java\tscript:x"))
        await client.post(
            f"{BASE_URL}/{created['id']}/decide",
            json={"decision": "approved", "reason": _doc_with_unsafe_media(" javascript:x")},
        )

    created_payload, updated_payload = (call.kwargs["payload"] for call in mock_bus.publish.call_args_list)
    _assert_stripped(created_payload["action_description"])
    _assert_stripped(updated_payload["decision_reason"])


SAFE_MARKUP = (
    "Delete 12 cards from Backlog: see ![shot](/api/workspaces/default/media/abc/shot.png) "
    "and [the plan](https://example.com/plan_(v2) \"Plan\"), [ref][r], <https://example.com/x>, "
    '<b>now</b> <img src="https://example.com/a.png" alt="a"> <a href=\'/kanban\'>board</a>\n\n'
    "[r]: https://example.com/ref\n"
)


async def test_plain_text_and_safe_media_approvals_are_stored_byte_identical(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent
):
    safe_doc = json.dumps({"type": "doc", "content": [{"type": "image", "attrs": {"src": SAFE_SRC}}]})
    payload = {
        "card_id": "abc",
        "details": SAFE_MARKUP,
        "nested": {"doc": json.loads(safe_doc), "list": [safe_doc, "plain", 3, None]},
    }

    plain = await _create(client, test_agent, SAFE_MARKUP, payload)
    assert plain["action_description"] == SAFE_MARKUP
    assert plain["action_payload"] == payload
    created = await _create(client, test_agent, safe_doc)
    assert created["action_description"] == safe_doc
    decided = await client.post(
        f"{BASE_URL}/{created['id']}/decide", json={"decision": "approved", "reason": SAFE_MARKUP}
    )
    assert decided.json()["decision_reason"] == SAFE_MARKUP


# --- action_payload: `details` renders through the same RichTextRenderer ------


@pytest.mark.parametrize("src", OBFUSCATED_JAVASCRIPT_SRCS)
async def test_action_payload_prosemirror_docs_are_stripped_at_any_depth(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent, src: str
):
    """Reviewer repro: `details` as an unsafe-image doc came back byte-identical.
    Agents choose the payload keys, so every doc-shaped value is stripped."""
    payload = {
        "card_id": "abc",
        "details": _doc_with_unsafe_media(src),
        "agent_chosen": {"deep": [json.loads(_doc_with_unsafe_media(src))]},
    }

    created = await _create(client, test_agent, "Delete 12 cards", payload)

    fetched = (await client.get(f"{BASE_URL}/{created['id']}")).json()
    for body in (created, fetched):
        _assert_stripped(body["action_payload"]["details"])
        _assert_stripped(json.dumps(body["action_payload"]["agent_chosen"]["deep"][0]))
        assert body["action_payload"]["card_id"] == "abc"


# --- markdown and HTML: the renderer parses both, so the backend scrubs both --

UNSAFE_MARKUP = [
    pytest.param("![pwn](javascript:alert(document.cookie))", id="md-image-reviewer-repro"),
    pytest.param("[click](javascript:alert(1))", id="md-link"),
    pytest.param("[click]( JaVaScRiPt:alert(1) 'title')", id="md-link-spaced-mixed-case"),
    pytest.param("![x](<java\tscript:alert(1)>)", id="md-angle-tab"),
    pytest.param("![x](java&#x73;cript:alert(1))", id="md-hex-entity"),
    pytest.param("[x](java&#115;cript:alert(1))", id="md-decimal-entity"),
    pytest.param("[x](javascript\\:alert(1))", id="md-backslash-escape"),
    pytest.param("[x](javascript:a((1)))", id="md-nested-parens"),
    pytest.param("[![x](/ok.png)](javascript:alert(1))", id="md-image-inside-link"),
    pytest.param("![x](//evil.example/x.png)", id="md-protocol-relative"),
    pytest.param("![x](data:image/svg+xml;base64,PHN2Zz4=)", id="md-data"),
    pytest.param("[x][r]\n\n[r]: javascript:alert(1)", id="md-reference-definition"),
    pytest.param("> [x][r]\n> [r]: <javascript:alert(1)>", id="md-reference-in-blockquote"),
    pytest.param("<javascript:alert(1)>", id="md-autolink"),
    pytest.param('<p><img src="javascript:alert(1)"></p>', id="html-img-double-quoted"),
    pytest.param("<p><img src='javascript:alert(1)'></p>", id="html-img-single-quoted"),
    pytest.param("<p><img src=javascript:alert(1)></p>", id="html-img-unquoted"),
    pytest.param('<p><IMG SRC="JAVASCRIPT:alert(1)"></p>', id="html-img-upper-case"),
    pytest.param("<p><img/src=javascript:alert(1)></p>", id="html-img-slash"),
    pytest.param('<p><img alt="a>b" src="javascript:alert(1)"></p>', id="html-img-gt-in-quoted-attr"),
    pytest.param('<p><img src="java&#x73;cript:alert(1)"></p>', id="html-img-hex-entity"),
    pytest.param('<p><img src="java&Tab;script:alert(1)"></p>', id="html-img-named-tab-entity"),
    pytest.param('<p><img\nsrc="//evil.example/x.png"></p>', id="html-img-newline-protocol-relative"),
    pytest.param('<p><a href="javascript:alert(1)">x</a></p>', id="html-link"),
    pytest.param("<p><a title='t' href=java&#115;cript:alert(1)>x</a></p>", id="html-link-unquoted-entity"),
    pytest.param('<p><a\thref="data:text/html,x">x</a></p>', id="html-link-data"),
]


def _assert_no_live_unsafe_url(stored: str) -> None:
    decoded = html.unescape(re.sub(r"\\([!-/:-@\[-`{-~])", r"\1", stored))
    collapsed = re.sub(r"[\x00-\x20]", "", decoded).lower()
    for marker in ("javascript:", "evil.example", "data:"):
        assert marker not in collapsed, stored


@pytest.mark.parametrize("markup", UNSAFE_MARKUP)
async def test_markdown_and_html_unsafe_urls_are_neutralised_in_every_rendered_field(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent, markup: str
):
    value = f"Before.\n\n{markup}\n\nAfter."
    created = await _create(client, test_agent, value, {"details": value, "card_id": "abc"})
    decided = await client.post(
        f"{BASE_URL}/{created['id']}/decide", json={"decision": "rejected", "reason": value}
    )
    assert decided.status_code == 200, decided.text

    fetched = (await client.get(f"{BASE_URL}/{created['id']}")).json()
    for body in (created, fetched):
        _assert_no_live_unsafe_url(body["action_description"])
        _assert_no_live_unsafe_url(body["action_payload"]["details"])
    for body in (decided.json(), fetched):
        _assert_no_live_unsafe_url(body["decision_reason"])
    for stored in (fetched["action_description"], fetched["decision_reason"], fetched["action_payload"]["details"]):
        assert stored.startswith("Before.\n\n") and stored.endswith("\n\nAfter.")


async def test_legacy_markup_and_payload_are_neutralised_on_read(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_agent: Agent
):
    legacy = ApprovalRequest(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        category=ApprovalCategory.deletion,
        action_description="![pwn](javascript:alert(1))",
        action_payload={"details": '<img src="javascript:alert(1)">', "x": [json.loads(_doc_with_unsafe_media("javascript:x"))]},
        risk_score=60,
        status=ApprovalStatus.rejected,
        decision_reason="[x](javascript:alert(1))",
        expires_at=utcnow() + timedelta(hours=24),
    )
    db_session.add(legacy)
    await db_session.flush()

    fetched = (await client.get(f"{BASE_URL}/{legacy.id}")).json()
    _assert_no_live_unsafe_url(fetched["action_description"])
    _assert_no_live_unsafe_url(fetched["decision_reason"])
    _assert_no_live_unsafe_url(json.dumps(fetched["action_payload"]))


async def test_legacy_stored_unsafe_media_is_stripped_on_read(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_agent: Agent
):
    """Rows written before the save-time strip still never reach a reader raw."""
    legacy = ApprovalRequest(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        category=ApprovalCategory.deletion,
        action_description=_doc_with_unsafe_media("javascript:alert(1)"),
        action_payload={},
        risk_score=60,
        status=ApprovalStatus.rejected,
        decision_reason=_doc_with_unsafe_media("java\nscript:alert(1)"),
        expires_at=utcnow() + timedelta(hours=24),
    )
    db_session.add(legacy)
    await db_session.flush()

    fetched = (await client.get(f"{BASE_URL}/{legacy.id}")).json()
    _assert_stripped(fetched["action_description"])
    _assert_stripped(fetched["decision_reason"])
    [listed] = [a for a in (await client.get(BASE_URL)).json() if a["id"] == str(legacy.id)]
    _assert_stripped(listed["action_description"])
    _assert_stripped(listed["decision_reason"])


# --- mailto: is a harmless LINK target; media keeps the strict allowlist ------

MAILTO_LINKS = (
    "Ask [ops](mailto:ops@example.com) or [Sam](<MailTo:sam@example.com> \"Sam\"), "
    "<mailto:oncall@example.com>, [desk][d], "
    '<a href="mailto:desk@example.com">desk</a>\n\n[d]: mailto:desk@example.com\n'
)


async def test_mailto_links_are_kept_byte_identical(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent
):
    created = await _create(client, test_agent, MAILTO_LINKS, {"details": MAILTO_LINKS})
    decided = await client.post(
        f"{BASE_URL}/{created['id']}/decide", json={"decision": "approved", "reason": MAILTO_LINKS}
    )

    assert created["action_description"] == MAILTO_LINKS
    assert created["action_payload"]["details"] == MAILTO_LINKS
    assert decided.json()["decision_reason"] == MAILTO_LINKS


@pytest.mark.parametrize(
    ("markup", "neutralised"),
    [
        pytest.param("![x](mailto:a@example.com)", "![x](<>)", id="md-image"),
        pytest.param(
            "[![x](mailto:a@example.com)](mailto:a@example.com)",
            "[![x](<>)](mailto:a@example.com)",
            id="md-image-inside-mailto-link",
        ),
        pytest.param('<img src="mailto:a@example.com">', "", id="html-img"),
        pytest.param("[x](javascript:mailto:a@example.com)", "[x](<>)", id="md-link-not-really-mailto"),
        pytest.param("[x]( mailto:a@example.com)", "[x]( mailto:a@example.com)", id="md-link-leading-space"),
    ],
)
async def test_mailto_is_still_refused_as_an_image_source(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent, markup: str, neutralised: str
):
    created = await _create(client, test_agent, f"See {markup} now")
    assert created["action_description"] == f"See {neutralised} now"


# --- size caps: the scrub runs in the request handler, so input is bounded ----


async def test_oversized_approval_text_and_payload_are_refused_before_any_scrub(
    client: AsyncClient, test_workspace: Workspace, test_agent: Agent
):
    """Reviewer repro: a 60 KB `[` run hung the create endpoint past 30 s."""
    from app.schemas.approvals.approval import ACTION_PAYLOAD_MAX_BYTES, APPROVAL_TEXT_MAX_LENGTH

    body = {"agent_id": str(test_agent.id), "category": "deletion", "action_description": "ok"}
    started = time.perf_counter()
    too_long = await client.post(BASE_URL, json={**body, "action_description": "[" * 60_000})
    huge_payload = await client.post(
        BASE_URL, json={**body, "action_payload": {"details": "x](" * (ACTION_PAYLOAD_MAX_BYTES // 3 + 1)}}
    )
    assert time.perf_counter() - started < 2
    assert too_long.status_code == 422
    assert huge_payload.status_code == 422

    at_cap = await _create(client, test_agent, "[" * APPROVAL_TEXT_MAX_LENGTH)
    over = await client.post(
        f"{BASE_URL}/{at_cap['id']}/decide",
        json={"decision": "approved", "reason": "x" * (APPROVAL_TEXT_MAX_LENGTH + 1)},
    )
    assert over.status_code == 422
