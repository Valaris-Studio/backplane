# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Excerpt authorization belongs to the service, including completed retries.

The source remains owned and readable in a different workspace. Removing the
current destination write permission must therefore refuse publication before
source verification or an existing receipt can return the saved note.
"""

import pytest
from sqlalchemy import delete, func, select, update

from app.exceptions import ForbiddenError
from app.models.notes.save_receipt import NoteSaveReceipt
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteCreate
from app.services.notes.note import NoteService
from tests.routers.notes.test_excerpt_note_route import (  # noqa: F401
    route_owner,
    route_source,
)
from tests.routers.notes.test_excerpt_note_save import (
    created_activity_count,
    excerpt_save,
    note_count,
    second_workspace,
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
