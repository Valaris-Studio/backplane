# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board skill bindings — /api/workspaces/{slug}/boards/{board_id}/skills.

RED phase for the Skills Registry (spec note f58cae0c).

A binding is workspace-skill × board with enabled + optional pinned_version.
GET returns the board's EFFECTIVE set: what a runner would materialize —
enabled bindings only, resolved to pinned_version when set, else the skill's
latest published version; a skill with nothing published and no pin resolves
to nothing and is excluded. Backplane only ANSWERS "which skills, which
version" — it never executes, renders, or interprets them.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace

from tests.routers.skills.conftest import make_member, skill_md


SKILLS_URL = "/api/workspaces/default/skills"

EFFECTIVE_ITEM_KEYS = {
    "skill_id",
    "slug",
    "name",
    "description",
    "version",
    "content_hash",
    "enabled",
    "pinned_version",
    "role",
    "toolsets",
    "uncovered_toolsets",
}


BINDING_ITEM_KEYS = {
    "skill_id",
    "slug",
    "name",
    "enabled",
    "pinned_version",
    "role",
    "resolved_version",
    "toolsets",
    "uncovered_toolsets",
}


def board_skills_url(board: Board) -> str:
    return f"/api/workspaces/default/boards/{board.id}/skills"


def board_bindings_url(board: Board) -> str:
    return f"{board_skills_url(board)}/bindings"


async def _seed_skill(
    client: AsyncClient,
    slug: str,
    published_versions: int = 1,
    draft_after: bool = False,
) -> dict:
    """A workspace skill with `published_versions` published versions (bodies
    differ so hashes differ), optionally topped with a trailing draft."""
    files = [{"path": "SKILL.md", "content": skill_md(name=slug, body="v1 body\n")}]
    created = await client.post(SKILLS_URL, json={"slug": slug, "files": files})
    assert created.status_code == 201, created.text

    for n in range(2, published_versions + 1):
        added = await client.post(
            f"{SKILLS_URL}/{slug}/versions",
            json={
                "files": [
                    {"path": "SKILL.md", "content": skill_md(name=slug, body=f"v{n} body\n")}
                ]
            },
        )
        assert added.status_code == 201, added.text
    for n in range(1, published_versions + 1):
        published = await client.post(f"{SKILLS_URL}/{slug}/versions/{n}/publish")
        assert published.status_code == 200, published.text
    if draft_after:
        drafted = await client.post(
            f"{SKILLS_URL}/{slug}/versions",
            json={
                "files": [
                    {"path": "SKILL.md", "content": skill_md(name=slug, body="draft body\n")}
                ]
            },
        )
        assert drafted.status_code == 201, drafted.text

    detail = await client.get(f"{SKILLS_URL}/{slug}")
    assert detail.status_code == 200, detail.text
    return detail.json()


# --- effective set -----------------------------------------------------------


async def test_list_board_skills_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(board_skills_url(test_board))
    assert response.status_code == 200, response.text
    assert response.json() == {"skills": []}


async def test_bind_and_list_effective_skill(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    skill = await _seed_skill(client, "review-ritual", published_versions=1)

    bound = await client.put(f"{board_skills_url(test_board)}/review-ritual", json={})
    assert bound.status_code == 200, bound.text

    response = await client.get(board_skills_url(test_board))
    assert response.status_code == 200, response.text
    items = response.json()["skills"]
    assert len(items) == 1
    item = items[0]
    assert set(item.keys()) == EFFECTIVE_ITEM_KEYS, item.keys()
    assert item["skill_id"] == skill["id"]
    assert item["slug"] == "review-ritual"
    assert item["version"] == 1
    assert item["content_hash"] == skill["versions"][0]["content_hash"]
    assert item["enabled"] is True
    assert item["pinned_version"] is None
    # `role` is reserved for v2 — carried, never populated by v1 logic.
    assert item["role"] is None


async def test_effective_skill_resolves_latest_published_not_draft(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    skill = await _seed_skill(
        client, "evolving", published_versions=2, draft_after=True
    )
    await client.put(f"{board_skills_url(test_board)}/evolving", json={})

    response = await client.get(board_skills_url(test_board))
    items = response.json()["skills"]
    assert len(items) == 1
    # Latest PUBLISHED wins — the newer draft (version 3) must not leak.
    assert items[0]["version"] == 2
    v2_hash = next(v["content_hash"] for v in skill["versions"] if v["version"] == 2)
    assert items[0]["content_hash"] == v2_hash


async def test_effective_skill_pinned_version_beats_latest(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    skill = await _seed_skill(client, "pinned", published_versions=2)
    bound = await client.put(
        f"{board_skills_url(test_board)}/pinned", json={"pinned_version": 1}
    )
    assert bound.status_code == 200, bound.text

    response = await client.get(board_skills_url(test_board))
    items = response.json()["skills"]
    assert len(items) == 1
    assert items[0]["version"] == 1
    assert items[0]["pinned_version"] == 1
    v1_hash = next(v["content_hash"] for v in skill["versions"] if v["version"] == 1)
    assert items[0]["content_hash"] == v1_hash


async def test_effective_set_excludes_disabled_binding(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "kept", published_versions=1)
    await _seed_skill(client, "muted", published_versions=1)
    await client.put(f"{board_skills_url(test_board)}/kept", json={})
    await client.put(
        f"{board_skills_url(test_board)}/muted", json={"enabled": False}
    )

    response = await client.get(board_skills_url(test_board))
    items = response.json()["skills"]
    assert [item["slug"] for item in items] == ["kept"]


async def test_effective_set_excludes_unpublished_unpinned_skill(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    # Draft-only skill: nothing published, nothing pinned — resolves to
    # nothing, so the effective set must not carry it.
    created = await client.post(
        SKILLS_URL,
        json={
            "slug": "draft-only",
            "files": [{"path": "SKILL.md", "content": skill_md(name="draft-only")}],
        },
    )
    assert created.status_code == 201, created.text
    bound = await client.put(f"{board_skills_url(test_board)}/draft-only", json={})
    assert bound.status_code == 200, bound.text

    response = await client.get(board_skills_url(test_board))
    assert response.json()["skills"] == []


# --- binding upsert ----------------------------------------------------------


async def test_bind_skill_upsert_idempotent(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "upserted", published_versions=2)
    url = f"{board_skills_url(test_board)}/upserted"

    first = await client.put(url, json={})
    assert first.status_code == 200, first.text
    again = await client.put(url, json={})
    assert again.status_code == 200, again.text

    # Second PUT with different fields UPDATES the same binding in place.
    pinned = await client.put(url, json={"pinned_version": 1, "enabled": True})
    assert pinned.status_code == 200, pinned.text

    response = await client.get(board_skills_url(test_board))
    items = response.json()["skills"]
    assert len(items) == 1
    assert items[0]["version"] == 1
    assert items[0]["pinned_version"] == 1


async def test_bind_skill_unpin_with_null(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "unpinnable", published_versions=2)
    url = f"{board_skills_url(test_board)}/unpinnable"
    await client.put(url, json={"pinned_version": 1})

    response = await client.put(url, json={"pinned_version": None})
    assert response.status_code == 200, response.text

    items = (await client.get(board_skills_url(test_board))).json()["skills"]
    assert items[0]["pinned_version"] is None
    assert items[0]["version"] == 2


async def test_update_binding_omitted_pinned_version_preserves_pin(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Omitting pinned_version must leave an existing pin unchanged.

    The MCP set_skill_binding tool omits the field when the caller passes
    None, and the board-settings toggle PUTs {"enabled": ...} alone —
    neither may silently unpin. Explicit null (test above) is the unpin
    lever; absence means "no change".
    """
    await _seed_skill(client, "pin-keeper", published_versions=2)
    url = f"{board_skills_url(test_board)}/pin-keeper"
    await client.put(url, json={"pinned_version": 1})

    response = await client.put(url, json={"enabled": False})
    assert response.status_code == 200, response.text
    assert response.json()["pinned_version"] == 1

    response = await client.put(url, json={"enabled": True})
    assert response.status_code == 200, response.text

    items = (await client.get(board_skills_url(test_board))).json()["skills"]
    assert items[0]["pinned_version"] == 1
    assert items[0]["version"] == 1


async def test_update_binding_omitted_enabled_preserves_disabled(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Omitting enabled must leave a disabled binding disabled.

    `enabled` is tri-state on the wire exactly like pinned_version: absence
    means "no change". Before this, the schema default (True) was applied
    unconditionally, so an unpin-only PUT (MCP clear_pin) silently re-enabled
    a deliberately disabled skill back into the board's effective set.
    """
    await _seed_skill(client, "quiet-skill", published_versions=2)
    url = f"{board_skills_url(test_board)}/quiet-skill"
    await client.put(url, json={"enabled": False, "pinned_version": 1})

    response = await client.put(url, json={"pinned_version": None})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is False
    assert body["pinned_version"] is None

    items = (await client.get(board_skills_url(test_board))).json()["skills"]
    assert items == []


async def test_bind_unknown_skill_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    # A successful bind first, so the 404 below can only mean "unknown skill
    # slug", not "the route doesn't exist yet".
    await _seed_skill(client, "real-skill", published_versions=1)
    bound = await client.put(f"{board_skills_url(test_board)}/real-skill", json={})
    assert bound.status_code == 200, bound.text

    response = await client.put(
        f"{board_skills_url(test_board)}/does-not-exist", json={}
    )
    assert response.status_code == 404, response.text


async def test_bind_skill_nonexistent_pinned_version_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "shallow", published_versions=1)
    response = await client.put(
        f"{board_skills_url(test_board)}/shallow", json={"pinned_version": 7}
    )
    assert response.status_code == 422, response.text


# --- unbind ------------------------------------------------------------------


async def test_unbind_skill_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "detachable", published_versions=1)
    url = f"{board_skills_url(test_board)}/detachable"
    await client.put(url, json={})

    response = await client.delete(url)
    assert response.status_code == 204, response.text

    items = (await client.get(board_skills_url(test_board))).json()["skills"]
    assert items == []


async def test_unbind_nonexistent_binding_idempotent(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "never-bound", published_versions=1)
    response = await client.delete(f"{board_skills_url(test_board)}/never-bound")
    assert response.status_code == 204, response.text


# --- gating ------------------------------------------------------------------


async def test_member_may_read_board_skills_but_not_bind(
    role_client: AsyncClient,
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_skill(client, "member-gate", published_versions=1)
    member = await make_member(db_session, test_workspace)
    headers = {"X-User-Email": member.email}
    url = f"{board_skills_url(test_board)}/member-gate"

    listing = await role_client.get(board_skills_url(test_board), headers=headers)
    assert listing.status_code == 200, listing.text

    bound = await role_client.put(url, json={}, headers=headers)
    assert bound.status_code == 403, bound.text
    unbound = await role_client.delete(url, headers=headers)
    assert unbound.status_code == 403, unbound.text


# --- raw bindings ------------------------------------------------------------
#
# The effective set answers "what would a runner materialize"; the bindings
# listing answers "what did an operator configure". The board-settings dialog
# needs the latter — reading the effective set made a disabled binding
# indistinguishable from no binding at all, so its Remove button vanished and
# a draft-only skill looked like a bind that had failed.


async def test_list_bindings_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(board_bindings_url(test_board))
    assert response.status_code == 200, response.text
    assert response.json() == {"bindings": []}


async def test_list_bindings_includes_disabled_binding(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    skill = await _seed_skill(client, "muted", published_versions=1)
    await client.put(
        f"{board_skills_url(test_board)}/muted", json={"enabled": False}
    )

    response = await client.get(board_bindings_url(test_board))
    assert response.status_code == 200, response.text
    bindings = response.json()["bindings"]
    assert len(bindings) == 1
    binding = bindings[0]
    assert set(binding.keys()) == BINDING_ITEM_KEYS, binding.keys()
    assert binding["skill_id"] == skill["id"]
    assert binding["slug"] == "muted"
    assert binding["name"] == "muted"
    assert binding["enabled"] is False
    assert binding["pinned_version"] is None
    assert binding["role"] is None
    # Disabled, but it still RESOLVES — the dialog shows the version it would
    # use the moment the operator re-enables it.
    assert binding["resolved_version"] == 1

    # The effective set is unchanged by this endpoint existing.
    assert (await client.get(board_skills_url(test_board))).json()["skills"] == []


async def test_list_bindings_draft_only_skill_has_null_resolved_version(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    created = await client.post(
        SKILLS_URL,
        json={
            "slug": "draft-only",
            "files": [{"path": "SKILL.md", "content": skill_md(name="draft-only")}],
        },
    )
    assert created.status_code == 201, created.text
    bound = await client.put(f"{board_skills_url(test_board)}/draft-only", json={})
    assert bound.status_code == 200, bound.text

    bindings = (await client.get(board_bindings_url(test_board))).json()["bindings"]
    assert len(bindings) == 1
    assert bindings[0]["slug"] == "draft-only"
    assert bindings[0]["enabled"] is True
    # Nothing published and nothing pinned: the bind is real but resolves to
    # nothing, which is exactly what the dialog must be able to show.
    assert bindings[0]["resolved_version"] is None

    assert (await client.get(board_skills_url(test_board))).json()["skills"] == []


async def test_list_bindings_reports_pinned_resolution(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "pinned", published_versions=2)
    await client.put(
        f"{board_skills_url(test_board)}/pinned", json={"pinned_version": 1}
    )

    bindings = (await client.get(board_bindings_url(test_board))).json()["bindings"]
    assert len(bindings) == 1
    assert bindings[0]["pinned_version"] == 1
    assert bindings[0]["resolved_version"] == 1


async def test_list_bindings_excludes_unbound_skill(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "bound", published_versions=1)
    await _seed_skill(client, "never-bound", published_versions=1)
    await client.put(f"{board_skills_url(test_board)}/bound", json={})

    bindings = (await client.get(board_bindings_url(test_board))).json()["bindings"]
    assert [b["slug"] for b in bindings] == ["bound"]


async def test_list_bindings_unbind_removes_the_row(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_skill(client, "temporary", published_versions=1)
    url = f"{board_skills_url(test_board)}/temporary"
    await client.put(url, json={"enabled": False})
    assert len((await client.get(board_bindings_url(test_board))).json()["bindings"]) == 1

    assert (await client.delete(url)).status_code == 204
    assert (await client.get(board_bindings_url(test_board))).json()["bindings"] == []


async def test_member_may_read_bindings(
    role_client: AsyncClient,
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_skill(client, "member-readable", published_versions=1)
    await client.put(f"{board_skills_url(test_board)}/member-readable", json={})
    member = await make_member(db_session, test_workspace)

    response = await role_client.get(
        board_bindings_url(test_board), headers={"X-User-Email": member.email}
    )
    assert response.status_code == 200, response.text
    assert [b["slug"] for b in response.json()["bindings"]] == ["member-readable"]
