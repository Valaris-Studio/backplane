# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Excerpt authorization belongs to the service, including completed retries.

The source remains owned and readable in a different workspace. Removing the
current destination write permission must therefore refuse publication before
source verification or an existing receipt can return the saved note.
"""

import uuid

import pytest
from sqlalchemy import delete, func, select, update

from app.core.auth import current_agent_id, current_api_key_installation_id
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.notes.save_receipt import NoteSaveReceipt
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteCreate
from app.services.notes.note import NoteService
from tests.routers.notes.test_excerpt_note_route import (  # noqa: F401
    route_owner,
    route_source,
)
from tests.routers.notes.test_excerpt_note_save import (
    add_member,
    created_activity_count,
    excerpt_save,
    note_count,
    second_workspace,
)
from tests.routers.notes.test_note_publication_revision import (
    inspect_revision,
    publication,  # noqa: F401
)

pytestmark = pytest.mark.usefixtures("content_storage")


@pytest.mark.parametrize("replay", [False, True], ids=["fresh", "completed-replay"])
@pytest.mark.parametrize("revocation", ["removed-membership", "viewer-role"])
async def test_excerpt_service_requires_current_destination_write_permission(
    replay,
    revocation,
    owner,
    db_session,
    test_user,
    test_workspace,
    source,
):
    destination, board = await second_workspace(db_session, test_user)
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = f"/api/workspaces/{destination.slug}/boards/{board.id}/notes/from-excerpt"
    expected_count = int(replay)
    if replay:
        created = await owner.post(url, json=payload)
        assert created.status_code == 201, created.text

    membership = (
        WorkspaceMember.workspace_id == destination.id,
        WorkspaceMember.user_id == test_user.id,
    )
    if revocation == "removed-membership":
        await db_session.execute(delete(WorkspaceMember).where(*membership))
    else:
        await db_session.execute(
            update(WorkspaceMember).where(*membership).values(role=WorkspaceRole.viewer)
        )
    await db_session.flush()

    # HTTP already guards this boundary; non-router callers need the same guard.
    refused = await owner.post(url, json=payload)
    assert refused.status_code == 403, refused.text
    assert await note_count(db_session, destination) == expected_count
    assert await created_activity_count(db_session) == expected_count

    with pytest.raises(ForbiddenError):
        await NoteService(db_session).save_note(
            destination.id,
            NoteCreate.model_validate(payload),
            test_user.id,
            board.id,
        )

    assert await note_count(db_session, destination) == expected_count
    assert await created_activity_count(db_session) == expected_count
    assert await db_session.scalar(
        select(func.count()).select_from(NoteSaveReceipt)
    ) == expected_count


@pytest.mark.parametrize("restriction", ["viewer", "frozen"])
async def test_publication_revision_service_accepts_current_read_only_permission(
    restriction, owner, db_session, test_user, test_workspace, test_board, publication
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    if restriction == "viewer":
        await db_session.execute(update(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        ).values(role=WorkspaceRole.viewer))
    else:
        await db_session.execute(update(Board).where(Board.id == test_board.id).values(is_frozen=True))
    inspected = await NoteService(db_session).get_note_publication_revision(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        note_id=uuid.UUID(saved["id"]),
        user_id=test_user.id,
    )
    assert inspected.comparison == "matches"


@pytest.mark.parametrize("denied", [
    "another-owner", "removed-membership", "agent", "companion",
    "wrong-board", "wrong-workspace", "missing-note",
])
async def test_publication_revision_service_itself_enforces_owner_and_destination_scope(
    denied, owner, db_session, test_user, second_user, test_workspace, test_board,
    publication,
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    arguments = {
        "workspace_id": test_workspace.id,
        "board_id": test_board.id,
        "note_id": uuid.UUID(saved["id"]),
        "user_id": test_user.id,
    }
    expected_error = ResourceNotFoundError
    agent_token = current_agent_id.set(None)
    installation_token = current_api_key_installation_id.set(None)
    try:
        if denied == "another-owner":
            await add_member(db_session, test_workspace, second_user)
            arguments["user_id"] = second_user.id
        elif denied == "removed-membership":
            await db_session.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == test_workspace.id,
                WorkspaceMember.user_id == test_user.id,
            ))
            expected_error = ForbiddenError
        elif denied == "agent":
            current_agent_id.set(uuid.uuid4())
            expected_error = ForbiddenError
        elif denied == "companion":
            current_api_key_installation_id.set(uuid.uuid4())
            expected_error = ForbiddenError
        elif denied in {"wrong-board", "wrong-workspace"}:
            workspace, board = await second_workspace(db_session, test_user)
            arguments["board_id"] = board.id
            if denied == "wrong-workspace":
                arguments["workspace_id"] = workspace.id
        else:
            arguments["note_id"] = uuid.uuid4()
        with pytest.raises(expected_error):
            await NoteService(db_session).get_note_publication_revision(**arguments)
    finally:
        current_agent_id.reset(agent_token)
        current_api_key_installation_id.reset(installation_token)
