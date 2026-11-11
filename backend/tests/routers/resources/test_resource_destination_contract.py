# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember


MAX_ANCESTORS = 32
ANCESTOR_FIELDS = {"id", "name", "resource_type", "workspace_id", "board_id"}


def base_url(board_id: uuid.UUID | None = None, slug: str = "default") -> str:
    board = f"/boards/{board_id}" if board_id else ""
    return f"/api/workspaces/{slug}{board}/resources"


async def create(client: AsyncClient, base: str, name: str, **fields) -> dict:
    response = await client.post(base, json={"name": name, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def ancestor(resource: dict) -> dict:
    return {key: resource[key] for key in ANCESTOR_FIELDS}


async def legacy_resource(
    db: AsyncSession, workspace: Workspace, user: User, *,
    board_id: uuid.UUID | None = None, parent_id: uuid.UUID | None = None,
    name: str = "Legacy folder", kind: ResourceType = ResourceType.folder,
) -> Resource:
    # Persist valid FK relationships that predate same-scope parent validation.
    row = Resource(
        workspace_id=workspace.id, board_id=board_id, parent_id=parent_id,
        resource_type=kind, name=name, uploaded_by=user.id,
        gcs_path=f"{workspace.id}/legacy/{uuid.uuid4()}.txt" if kind == ResourceType.file else None,
        description="Metadata that must not be copied into breadcrumbs", meta={"tags": ["private-label"]},
    )
    db.add(row)
    await db.flush()
    return row


@pytest.mark.parametrize("scope", ["workspace", "board"])
async def test_exact_detail_outside_folder_and_filter_has_only_authorized_ancestor_metadata(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, scope: str,
):
    base = base_url(test_board.id if scope == "board" else None)
    outer = await create(client, base, "Design", resource_type="folder")
    inner = await create(client, base, "Final", resource_type="folder", parent_id=outer["id"])
    target = await create(client, base, "exact.txt", parent_id=inner["id"], mime_type="text/plain")
    visible = await create(client, base, "visible.txt")

    root = await client.get(base)
    assert root.status_code == 200
    assert {item["id"] for item in root.json()} == {outer["id"], visible["id"]}
    filtered = await client.get(base, params={"q": "visible", "resource_type": "file"})
    assert filtered.status_code == 200
    assert [item["id"] for item in filtered.json()] == [visible["id"]]
    assert all("ancestors" not in item and "ancestors_complete" not in item for item in root.json())

    response = await client.get(f"{base}/{target['id']}")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == target["id"] and data["parent_id"] == inner["id"]
    assert data.get("ancestors") == [ancestor(outer), ancestor(inner)]
    assert data.get("ancestors_complete") is True
    assert all(set(item) == ANCESTOR_FIELDS for item in data["ancestors"])
    assert "download_url" not in data and "content" not in data


@pytest.mark.parametrize("scope", ["workspace", "board"])
async def test_root_detail_has_an_explicit_complete_empty_path(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, scope: str,
):
    base = base_url(test_board.id if scope == "board" else None)
    target = await create(client, base, "Root", resource_type="folder")
    response = await client.get(f"{base}/{target['id']}")
    assert response.status_code == 200
    assert response.json().get("ancestors") == []
    assert response.json().get("ancestors_complete") is True


async def test_workspace_detail_alias_preserves_actual_board_and_exact_board_route_denies_mismatch(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User,
):
    base = base_url(test_board.id)
    folder = await create(client, base, "Board folder", resource_type="folder")
    target = await create(client, base, "board.txt", parent_id=folder["id"])
    other = Board(workspace_id=test_workspace.id, name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    denied = await client.get(f"{base_url(other.id)}/{target['id']}")
    assert denied.status_code == 404
    assert "board.txt" not in denied.text and folder["id"] not in denied.text

    alias = await client.get(f"{base_url()}/{target['id']}")
    assert alias.status_code == 200, alias.text
    assert alias.json()["board_id"] == str(test_board.id)
    assert alias.json().get("ancestors") == [ancestor(folder)]
    assert alias.json().get("ancestors_complete") is True


async def test_exact_detail_uses_current_folder_move_and_rename(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
):
    base = base_url(test_board.id)
    old = await create(client, base, "Old folder", resource_type="folder")
    current = await create(client, base, "Current folder", resource_type="folder")
    target = await create(client, base, "before.txt", parent_id=old["id"])
    moved = await client.put(f"{base}/{target['id']}", json={"parent_id": current["id"], "name": "after.txt"})
    assert moved.status_code == 200
    renamed = await client.put(f"{base}/{current['id']}", json={"name": "Renamed current folder"})
    assert renamed.status_code == 200

    response = await client.get(f"{base}/{target['id']}")
    assert response.status_code == 200
    assert response.json()["name"] == "after.txt"
    assert response.json()["parent_id"] == current["id"]
    assert response.json().get("ancestors") == [ancestor(renamed.json())]
    assert response.json().get("ancestors_complete") is True


@pytest.mark.parametrize("parent_problem", ["wrong_board", "wrong_workspace", "nonfolder"])
async def test_legacy_invalid_parent_is_not_a_navigable_ancestor_on_either_detail_route(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User, parent_problem: str,
):
    parent_workspace = test_workspace
    parent_board = test_board.id
    kind = ResourceType.folder
    if parent_problem == "wrong_board":
        other = Board(workspace_id=test_workspace.id, name="Other", slug="other", created_by=test_user.id)
        db_session.add(other)
        await db_session.flush()
        parent_board = other.id
    elif parent_problem == "wrong_workspace":
        parent_workspace = Workspace(name="Denied", slug="denied", created_by=test_user.id)
        db_session.add(parent_workspace)
        await db_session.flush()
        parent_board = None
    else:
        kind = ResourceType.file
    parent = await legacy_resource(db_session, parent_workspace, test_user, board_id=parent_board,
                                   name="Do not expose this ancestor", kind=kind)
    target = await legacy_resource(db_session, test_workspace, test_user, board_id=test_board.id,
                                   parent_id=parent.id, name="Authorized target", kind=ResourceType.file)
    if parent_problem == "wrong_workspace":
        denied = await client.get(f"{base_url(slug='denied')}/{parent.id}")
        assert denied.status_code == 403
    for base in (base_url(test_board.id), base_url()):
        response = await client.get(f"{base}/{target.id}")
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "Authorized target"
        assert response.json().get("ancestors") == []
        assert response.json().get("ancestors_complete") is False
        assert parent.name not in response.text
        # The old target.parent_id remains its own metadata; ancestor objects
        # must not introduce an unresolved parent ID or foreign scope metadata.
        assert "private-label" not in str(response.json()["ancestors"])


async def test_legacy_cycle_stops_without_repeating_target_or_ancestor(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User,
):
    first = await legacy_resource(db_session, test_workspace, test_user, board_id=test_board.id, name="First")
    second = await legacy_resource(db_session, test_workspace, test_user, board_id=test_board.id,
                                   parent_id=first.id, name="Second")
    first.parent_id = second.id
    await db_session.flush()
    response = await client.get(f"{base_url(test_board.id)}/{first.id}")
    assert response.status_code == 200
    data = response.json()
    assert data.get("ancestors_complete") is False
    ancestors = data.get("ancestors")
    assert isinstance(ancestors, list)
    ids = [item["id"] for item in ancestors]
    assert len(ids) == len(set(ids)) <= MAX_ANCESTORS
    assert str(first.id) not in ids
    assert set(ids).issubset({str(second.id)})


async def test_deep_path_returns_the_nearest_32_authorized_ancestors_and_discloses_truncation(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User,
):
    folders = []
    for depth in range(MAX_ANCESTORS + 3):
        folders.append(await legacy_resource(
            db_session, test_workspace, test_user, board_id=test_board.id,
            parent_id=folders[-1].id if folders else None, name=f"Folder {depth}",
        ))
    target = await legacy_resource(db_session, test_workspace, test_user, board_id=test_board.id,
                                   parent_id=folders[-1].id, name="Deep file", kind=ResourceType.file)
    response = await client.get(f"{base_url(test_board.id)}/{target.id}")
    assert response.status_code == 200
    data = response.json()
    assert data.get("ancestors_complete") is False
    assert [item["id"] for item in data.get("ancestors", [])] == [str(row.id) for row in folders[-MAX_ANCESTORS:]]
    assert all(set(item) == ANCESTOR_FIELDS for item in data["ancestors"])


async def test_current_deletion_and_membership_revocation_deny_previously_read_targets(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User,
):
    base = base_url(test_board.id)
    removed = await create(client, base, "deleted.txt")
    retained = await create(client, base, "retained.txt")
    assert (await client.get(f"{base}/{removed['id']}")).status_code == 200
    assert (await client.delete(f"{base}/{removed['id']}")).status_code == 204
    missing = await client.get(f"{base}/{removed['id']}")
    assert missing.status_code == 404 and "deleted.txt" not in missing.text
    await db_session.execute(delete(WorkspaceMember).where(
        WorkspaceMember.workspace_id == test_workspace.id, WorkspaceMember.user_id == test_user.id,
    ))
    await db_session.flush()
    revoked = await client.get(f"{base}/{retained['id']}")
    assert revoked.status_code == 403
    assert "retained.txt" not in revoked.text and "ancestors" not in revoked.json()


@pytest.mark.parametrize("scope", ["workspace", "board"])
async def test_folder_listing_excludes_fk_valid_children_outside_its_actual_scope(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User, scope: str,
):
    base = base_url(test_board.id if scope == "board" else None)
    folder = await create(client, base, "Authorized folder", resource_type="folder")
    child = await create(client, base, "Authorized child.txt", parent_id=folder["id"])
    other_board = Board(
        workspace_id=test_workspace.id, name="Different child scope",
        slug="different-child-scope", created_by=test_user.id,
    )
    denied_workspace = Workspace(
        name="Nonmember child scope", slug="nonmember-child-scope", created_by=test_user.id,
    )
    db_session.add_all([other_board, denied_workspace])
    await db_session.flush()
    # All FKs remain valid. These legacy children share the authorized parent
    # ID but their own board/workspace identities are outside its list scope.
    wrong_board = await legacy_resource(
        db_session, test_workspace, test_user, board_id=other_board.id,
        parent_id=uuid.UUID(folder["id"]), name="Foreign board child.txt", kind=ResourceType.file,
    )
    foreign_child = await legacy_resource(
        db_session, denied_workspace, test_user, parent_id=uuid.UUID(folder["id"]),
        name="Nonmember child secret.txt", kind=ResourceType.file,
    )
    # Exact workspace lookup remains an alias for a board resource. Listing
    # a workspace folder is a different operation and must not widen scope.
    alias = await client.get(f"{base_url()}/{wrong_board.id}")
    assert alias.status_code == 200, alias.text
    assert alias.json()["board_id"] == str(other_board.id)
    if scope == "board":
        exact_wrong_board = await client.get(f"{base}/{wrong_board.id}")
        assert exact_wrong_board.status_code == 404
    denied = await client.get(f"{base_url(slug=denied_workspace.slug)}/{foreign_child.id}")
    assert denied.status_code == 403
    assert foreign_child.name not in denied.text
    positive = await client.get(f"{base}/{child['id']}")
    assert positive.status_code == 200 and positive.json()["id"] == child["id"]
    root = await client.get(base)
    assert root.status_code == 200
    assert {item["id"] for item in root.json()} == {folder["id"]}

    listed = await client.get(base, params={"parent_id": folder["id"]})
    assert listed.status_code == 200, listed.text
    assert {item["id"] for item in listed.json()} == {child["id"]}
    assert all(item["workspace_id"] == str(test_workspace.id) for item in listed.json())
    expected_board = str(test_board.id) if scope == "board" else None
    assert all(item["board_id"] == expected_board for item in listed.json())
    assert wrong_board.name not in listed.text and foreign_child.name not in listed.text


@pytest.mark.parametrize("scope", ["workspace", "board"])
@pytest.mark.parametrize("filter_name", ["resource_type", "tag"])
async def test_type_or_tag_filter_keeps_nested_folder_while_text_search_spans_scope(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    scope: str, filter_name: str,
):
    base = base_url(test_board.id if scope == "board" else None)
    folder = await create(client, base, "Nested", resource_type="folder")
    selected = await create(
        client, base, "scope-match nested.txt", parent_id=folder["id"],
        metadata={"tags": ["keep"]},
    )
    other_file = await create(
        client, base, "Other nested file.txt", parent_id=folder["id"],
        metadata={"tags": ["other"]},
    )
    tagged_folder = await create(
        client, base, "Tagged nested folder", resource_type="folder", parent_id=folder["id"],
        metadata={"tags": ["keep"]},
    )
    root_match = await create(
        client, base, "scope-match root.txt", metadata={"tags": ["keep"]},
    )
    ordinary = await client.get(base, params={"parent_id": folder["id"]})
    assert ordinary.status_code == 200
    assert {item["id"] for item in ordinary.json()} == {
        selected["id"], other_file["id"], tagged_folder["id"],
    }
    # Text search intentionally ignores the folder within the same authorized
    # scope; adding type/tag restrictions must retain this shipped behavior.
    searched = await client.get(base, params={
        "parent_id": folder["id"], "q": "scope-match", "resource_type": "file", "tag": "keep",
    })
    assert searched.status_code == 200, searched.text
    assert {item["id"] for item in searched.json()} == {selected["id"], root_match["id"]}

    value = "file" if filter_name == "resource_type" else "keep"
    filtered = await client.get(base, params={"parent_id": folder["id"], filter_name: value})
    assert filtered.status_code == 200, filtered.text
    expected = {selected["id"], other_file["id"] if filter_name == "resource_type" else tagged_folder["id"]}
    assert {item["id"] for item in filtered.json()} == expected
    assert all(item["parent_id"] == folder["id"] for item in filtered.json())
    assert root_match["id"] not in {item["id"] for item in filtered.json()}


@pytest.mark.parametrize("filter_name", ["ordinary", "resource_type", "tag"])
async def test_workspace_parent_alias_uses_authorized_board_folder_scope_with_filters(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_board: Board, test_user: User, filter_name: str,
):
    board_base = base_url(test_board.id)
    workspace_base = base_url()
    folder = await create(client, board_base, "Board alias folder", resource_type="folder")
    selected = await create(
        client, board_base, "alias-query board keep.txt", parent_id=folder["id"],
        metadata={"tags": ["keep"]},
    )
    other_file = await create(
        client, board_base, "Board other.txt", parent_id=folder["id"],
        metadata={"tags": ["other"]},
    )
    tagged_folder = await create(
        client, board_base, "Board tagged child", resource_type="folder", parent_id=folder["id"],
        metadata={"tags": ["keep"]},
    )
    workspace_root = await create(
        client, workspace_base, "alias-query workspace root.txt", metadata={"tags": ["keep"]},
    )
    workspace_folder = await create(
        client, workspace_base, "Workspace nested", resource_type="folder",
    )
    workspace_nested = await create(
        client, workspace_base, "alias-query workspace nested.txt",
        parent_id=workspace_folder["id"], metadata={"tags": ["keep"]},
    )
    other_board = Board(
        workspace_id=test_workspace.id, name="Outside alias board",
        slug="outside-alias-board", created_by=test_user.id,
    )
    foreign_workspace = Workspace(
        name="Outside alias workspace", slug="outside-alias-workspace", created_by=test_user.id,
    )
    db_session.add_all([other_board, foreign_workspace])
    await db_session.flush()
    wrong_board = await legacy_resource(
        db_session, test_workspace, test_user, board_id=other_board.id,
        parent_id=uuid.UUID(folder["id"]), name="alias-query wrong-board child.txt", kind=ResourceType.file,
    )
    foreign_child = await legacy_resource(
        db_session, foreign_workspace, test_user, parent_id=uuid.UUID(folder["id"]),
        name="alias-query foreign-workspace child.txt", kind=ResourceType.file,
    )
    foreign_folder = await legacy_resource(
        db_session, foreign_workspace, test_user, name="Foreign workspace folder",
    )
    # Every forged child matches the tag filter, so scope exclusion cannot
    # accidentally pass merely because the private rows have a different tag.
    wrong_board.meta = {"tags": ["keep"]}
    foreign_child.meta = {"tags": ["keep"]}
    await db_session.flush()

    params = {"parent_id": folder["id"]}
    if filter_name == "resource_type":
        params["resource_type"] = "file"
        expected_ids = {selected["id"], other_file["id"]}
    elif filter_name == "tag":
        params["tag"] = "keep"
        expected_ids = {selected["id"], tagged_folder["id"]}
    else:
        expected_ids = {selected["id"], other_file["id"], tagged_folder["id"]}

    positive = await client.get(board_base, params=params)
    assert positive.status_code == 200, positive.text
    assert {item["id"] for item in positive.json()} == expected_ids
    assert wrong_board.name not in positive.text and foreign_child.name not in positive.text
    detail_alias = await client.get(f"{workspace_base}/{folder['id']}")
    assert detail_alias.status_code == 200
    assert detail_alias.json()["board_id"] == str(test_board.id)
    wrong_route = await client.get(base_url(other_board.id), params=params)
    assert wrong_route.status_code == 404
    assert folder["name"] not in wrong_route.text
    foreign_params = {**params, "parent_id": str(foreign_folder.id)}
    for route in (board_base, workspace_base):
        denied_parent = await client.get(route, params=foreign_params)
        assert denied_parent.status_code == 404
        assert foreign_folder.name not in denied_parent.text
    denied_workspace = await client.get(
        f"{base_url(slug=foreign_workspace.slug)}/{foreign_child.id}",
    )
    assert denied_workspace.status_code == 403
    assert foreign_child.name not in denied_workspace.text

    # A text query retains route-wide semantics: the explicit board parent
    # does not turn a workspace search into a board search or a folder search.
    searched = await client.get(workspace_base, params={
        "parent_id": folder["id"], "q": "alias-query", "resource_type": "file", "tag": "keep",
    })
    assert searched.status_code == 200, searched.text
    assert {item["id"] for item in searched.json()} == {workspace_root["id"], workspace_nested["id"]}
    assert all(item["board_id"] is None for item in searched.json())

    aliased_children = await client.get(workspace_base, params=params)
    assert aliased_children.status_code == 200, aliased_children.text
    assert {item["id"] for item in aliased_children.json()} == expected_ids
    assert all(item["parent_id"] == folder["id"] for item in aliased_children.json())
    assert all(item["board_id"] == str(test_board.id) for item in aliased_children.json())
    assert all(item["workspace_id"] == str(test_workspace.id) for item in aliased_children.json())
    assert wrong_board.name not in aliased_children.text and foreign_child.name not in aliased_children.text
