# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP regressions for the opt-in landing/completion contract."""

from copy import deepcopy

import pytest
from sqlalchemy import select

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


def policy(**changes):
    value = {
        "version": 1,
        "landing_actor": "agent",
        "landing_methods": ["merge_queue"],
        "source_review": "none",
        "review_role": None,
        "require_forge_checks": False,
        "postmerge_validation": None,
        "evidence_only": {
            "enabled": False, "approval": "none", "review_role": None,
        },
        "dependency_release": "done",
        "auto_complete": True,
    }
    value.update(deepcopy(changes))
    return value


def board_url(board):
    return f"/api/workspaces/default/boards/{board.id}"


def completion_url(board):
    return f"{board_url(board)}/completion"


async def save_policy(client, board, value=None):
    value = policy() if value is None else value
    response = await client.put(
        f"{completion_url(board)}/policy", json={"policy": value},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def done_column(db, board):
    column = Column(
        board_id=board.id, name="Released", column_type=ColumnType.done,
        position=4096, color="#333333",
    )
    db.add(column)
    await db.flush()
    return column


async def test_absent_policy_resolves_legacy_without_migrating_board(
    client, db_session, test_board,
):
    response = await client.get(f"{completion_url(test_board)}/policy")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["origin"] == "legacy"
    assert body["effective_policy"] is None
    assert body["override"] is None
    assert body["workspace_policy"] is None
    assert body["policy_hash"] is None
    await db_session.refresh(test_board)
    assert test_board.loop_config is None
    assert test_board.enforce_done_merge_gate is None


async def test_board_policy_whole_object_override_and_null_inheritance(
    client, test_board, test_git_repo,
):
    workspace_policy = policy(auto_complete=False, dependency_release="accepted")
    response = await client.patch(
        "/api/workspaces/default/config",
        json={"completion_policy": workspace_policy},
    )
    assert response.status_code == 200, response.text
    assert response.json()["completion_policy"] == workspace_policy
    inherited = await client.get(f"{completion_url(test_board)}/policy")
    assert inherited.status_code == 200, inherited.text
    assert inherited.json()["origin"] == "workspace"
    assert inherited.json()["effective_policy"] == workspace_policy

    board_policy = policy()
    saved = await save_policy(client, test_board, board_policy)
    assert saved["origin"] == "board"
    assert saved["effective_policy"] == board_policy
    assert saved["workspace_policy"] == workspace_policy
    assert saved["policy_hash"] != inherited.json()["policy_hash"]

    cleared = await client.put(
        f"{completion_url(test_board)}/policy", json={"policy": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["origin"] == "workspace"
    assert cleared.json()["effective_policy"] == workspace_policy
    assert cleared.json()["policy_hash"] == inherited.json()["policy_hash"]


async def test_disabled_board_preview_shows_changes_without_writing(
    client, db_session, test_board, test_git_repo,
):
    before = await client.get(f"{board_url(test_board)}")
    response = await client.post(
        f"{completion_url(test_board)}/policy/preview", json={"policy": policy()},
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["effective_policy"] == policy()
    assert preview["origin"] == "board"
    assert preview["changes"]
    assert preview["incompatibilities"] == []
    after = await client.get(f"{board_url(test_board)}")
    assert after.json() == before.json()
    persisted = await client.get(f"{completion_url(test_board)}/policy")
    assert persisted.json()["origin"] == "legacy"
    await db_session.refresh(test_board)
    assert test_board.loop_config is None


async def test_unknown_policy_version_rejected_without_mutation(
    client, test_board, test_git_repo,
):
    response = await client.put(
        f"{completion_url(test_board)}/policy",
        json={"policy": policy(version=999)},
    )
    assert response.status_code == 422, response.text
    persisted = await client.get(f"{completion_url(test_board)}/policy")
    assert persisted.json()["origin"] == "legacy"


async def test_unsupported_forge_preview_explains_and_save_cannot_downgrade(
    client, db_session, test_board, test_git_repo,
):
    test_git_repo.provider = GitProvider.gitlab
    test_git_repo.url = "https://gitlab.example.test/team/repo"
    await db_session.flush()
    preview = await client.post(
        f"{completion_url(test_board)}/policy/preview", json={"policy": policy()},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["incompatibilities"]
    assert "gitlab" in str(preview.json()["incompatibilities"]).lower()
    saved = await client.put(
        f"{completion_url(test_board)}/policy", json={"policy": policy()},
    )
    assert saved.status_code == 422, saved.text
    unchanged = await client.get(f"{completion_url(test_board)}/policy")
    assert unchanged.json()["origin"] == "legacy"


@pytest.mark.parametrize("scope", ["board", "workspace"])
async def test_agent_owner_key_cannot_write_completion_policy(
    agent_client, test_board, test_git_repo, scope,
):
    if scope == "board":
        response = await agent_client.put(
            f"{completion_url(test_board)}/policy", json={"policy": policy()},
        )
    else:
        response = await agent_client.patch(
            "/api/workspaces/default/config", json={"completion_policy": policy()},
        )
    assert response.status_code == 403, response.text


async def test_non_admin_creator_cannot_write_completion_policy(
    client, db_session, test_board, test_workspace, test_user, test_git_repo,
):
    member = await db_session.scalar(select(WorkspaceMember).where(
        WorkspaceMember.workspace_id == test_workspace.id,
        WorkspaceMember.user_id == test_user.id,
    ))
    member.role = WorkspaceRole.member
    await db_session.flush()
    response = await client.put(
        f"{completion_url(test_board)}/policy", json={"policy": policy()},
    )
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("entry_path", ["move", "create", "bulk", "column_type"])
async def test_unaccepted_source_cannot_enter_done_by_any_public_mutation(
    client, db_session, test_board, test_card, test_git_repo, entry_path,
):
    await save_policy(client, test_board)
    done = await done_column(db_session, test_board)
    cards_url = f"{board_url(test_board)}/cards"
    if entry_path == "move":
        response = await client.patch(
            f"{cards_url}/{test_card.id}/move", json={"column_id": str(done.id)},
        )
    elif entry_path == "create":
        response = await client.post(
            cards_url, json={"title": "Bypass", "column_id": str(done.id)},
        )
    elif entry_path == "bulk":
        response = await client.post(f"{cards_url}/bulk", json={"cards": [
            {"title": "Valid first", "column_id": str(test_card.column_id)},
            {"title": "Bypass", "column_id": str(done.id)},
        ]})
    else:
        response = await client.patch(
            f"{board_url(test_board)}/columns/{test_card.column_id}",
            json={"column_type": "done"},
        )
    assert response.status_code in (409, 422), response.text
    await db_session.refresh(test_card)
    assert test_card.column_id != done.id
    column = await db_session.get(Column, test_card.column_id)
    assert column.column_type != ColumnType.done
    all_cards = (await db_session.scalars(select(Card).where(
        Card.board_id == test_board.id,
    ))).all()
    assert [card.id for card in all_cards] == [test_card.id]


async def test_legacy_human_move_remains_available(
    client, db_session, test_board, test_card, test_git_repo,
):
    done = await done_column(db_session, test_board)
    response = await client.patch(
        f"{board_url(test_board)}/cards/{test_card.id}/move",
        json={"column_id": str(done.id)},
    )
    assert response.status_code == 200, response.text
    assert response.json()["column_id"] == str(done.id)


async def test_legacy_self_merge_save_does_not_rewrite_explicit_policy(
    client, db_session, test_board, test_git_repo,
):
    saved = await save_policy(client, test_board)
    response = await client.put(
        f"{board_url(test_board)}/loop", json={"loop_landing": "self_merge"},
    )
    assert response.status_code == 200, response.text
    current = await client.get(f"{completion_url(test_board)}/policy")
    assert current.json()["policy_hash"] == saved["policy_hash"]
    assert current.json()["effective_policy"] == policy()
    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def make_foreign_card(db, user):
    workspace = Workspace(name="Private", slug="private", created_by=user.id)
    db.add(workspace)
    await db.flush()
    board = Board(workspace_id=workspace.id, name="Private", created_by=user.id)
    db.add(board)
    await db.flush()
    column = Column(board_id=board.id, name="Review", position=1024)
    db.add(column)
    await db.flush()
    card = Card(
        board_id=board.id, column_id=column.id, title="Private source",
        description="", created_by=user.id, position=1024,
    )
    repo = GitRepo(
        board_id=board.id, workspace_id=workspace.id, name="Private",
        slug="private", url="https://github.com/private/repo",
        provider=GitProvider.github, default_branch="main", added_by=user.id,
    )
    db.add_all([card, repo])
    await db.flush()
    return workspace, board, card, repo


@pytest.mark.parametrize("existing_entry", [False, True])
async def test_queue_enqueue_validates_card_tenant_before_idempotent_lookup(
    client, db_session, test_workspace, test_git_repo, second_user, existing_entry,
):
    foreign_workspace, _, card, foreign_repo = await make_foreign_card(
        db_session, second_user,
    )
    if existing_entry:
        db_session.add(MergeQueueEntry(
            card_id=card.id, repo_id=foreign_repo.id,
            workspace_id=foreign_workspace.id, integration_branch="main",
            pr_url="https://github.com/private/repo/pull/71",
            pr_branch="private-change", state="queued",
        ))
        await db_session.flush()
    response = await client.post("/api/workspaces/default/merge-queue/enqueue", json={
        "card_id": str(card.id), "repo_id": str(test_git_repo.id),
        "pr_url": "https://github.com/valaris/test-repo/pull/1",
        "pr_branch": "source-change", "integration_branch": "main",
    })
    assert response.status_code == 404, response.text
    assert "private-change" not in response.text
    entries = (await db_session.scalars(select(MergeQueueEntry).where(
        MergeQueueEntry.workspace_id == test_workspace.id,
    ))).all()
    assert entries == []


async def test_completion_routes_do_not_disclose_foreign_card(
    client, db_session, test_board, second_user,
):
    _, _, card, _ = await make_foreign_card(db_session, second_user)
    response = await client.get(f"{completion_url(test_board)}/cards/{card.id}")
    assert response.status_code == 404, response.text
    assert card.title not in response.text


async def test_cleared_override_is_validated_before_workspace_policy_change(
    client, db_session, test_board, test_git_repo,
):
    await save_policy(client, test_board)
    clear = await client.put(f"{completion_url(test_board)}/policy", json={"policy": None})
    assert clear.status_code == 200
    test_git_repo.provider = GitProvider.gitlab
    await db_session.flush()
    response = await client.patch("/api/workspaces/default/config", json={"completion_policy": policy()})
    assert response.status_code == 422, response.text
    read = await client.get(f"{completion_url(test_board)}/policy")
    assert read.json()["origin"] == "legacy"


@pytest.mark.parametrize("path", ["mode", "update", "create", "bulk"])
async def test_agent_cannot_select_evidence_only_mode(
    agent_client, client, test_board, test_card, test_git_repo, path,
):
    await save_policy(client, test_board, policy(evidence_only={
        "enabled": True, "approval": "none", "review_role": None,
    }))
    cards_url = f"{board_url(test_board)}/cards"
    if path == "mode":
        response = await agent_client.put(
            f"{completion_url(test_board)}/cards/{test_card.id}/mode",
            json={"completion_mode": "evidence_only"},
        )
    elif path == "update":
        response = await agent_client.patch(
            f"{cards_url}/{test_card.id}", json={"completion_mode": "evidence_only"},
        )
    else:
        payload = {"title": "Evidence", "column_id": str(test_card.column_id), "completion_mode": "evidence_only"}
        response = await agent_client.post(cards_url if path == "create" else f"{cards_url}/bulk", json=payload if path == "create" else {"cards": [payload]})
    assert response.status_code == 403, response.text


async def test_mode_requires_operator_and_explicit_evidence_enablement(
    client, db_session, test_board, test_card, test_git_repo, test_workspace, test_user,
):
    from app.exceptions import ForbiddenError
    from app.services.completion_policy import CompletionPolicyService

    disabled = await client.put(f"{completion_url(test_board)}/cards/{test_card.id}/mode", json={"completion_mode": "evidence_only"})
    assert disabled.status_code == 422
    await save_policy(client, test_board, policy(evidence_only={
        "enabled": True, "approval": "none", "review_role": None,
    }))
    enabled = await client.put(f"{completion_url(test_board)}/cards/{test_card.id}/mode", json={"completion_mode": "evidence_only"})
    assert enabled.status_code == 200, enabled.text
    await db_session.refresh(test_card)
    assert test_card.completion_mode == "evidence_only"
    member = await db_session.scalar(select(WorkspaceMember).where(
        WorkspaceMember.workspace_id == test_workspace.id, WorkspaceMember.user_id == test_user.id,
    ))
    member.role = WorkspaceRole.member
    await db_session.flush()
    with pytest.raises(ForbiddenError):
        await CompletionPolicyService(db_session).set_mode(test_board.id, test_workspace.id, test_user.id, test_card.id, "source")
    assert test_card.completion_mode == "evidence_only"


async def test_explicit_policy_rejects_unknown_repo_on_single_create(
    client, test_board, test_card, test_git_repo,
):
    await save_policy(client, test_board)
    response = await client.post(f"{board_url(test_board)}/cards", json={
        "title": "Exact source target", "column_id": str(test_card.column_id),
        "git_repo_slug": "missing-target",
    })
    assert response.status_code == 422, response.text
