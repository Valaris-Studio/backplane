# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-0 mention producer — end-to-end wiring (contract §4, MEN-5).

Real HTTP flows through the live FastAPI app + SQLite. The actor is test_user
(the `client` fixture's authenticated owner); a second workspace member is the
mention recipient. Each surface (card create + PATCH, note create + update) must
emit EXACTLY ONE `mention` notification for the mentioned member and ZERO for
the actor (INV-3). The producer is the SAME for both surfaces.
"""

from __future__ import annotations

import json
import uuid

import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

CARDS_BASE = "/api/workspaces/default/boards"


@pytest_asyncio.fixture
async def mentioned_member(db_session: AsyncSession, test_workspace: Workspace) -> User:
    user = User(email="mentionee@valaris.dev", name="Mentionee")
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    return user


def _mention_doc(user_id: uuid.UUID) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "cc "},
                        {
                            "type": "mention",
                            "attrs": {"id": str(user_id), "label": "Mentionee"},
                        },
                    ],
                }
            ],
        }
    )


async def _mention_rows(
    db: AsyncSession, recipient_id: uuid.UUID
) -> list[Notification]:
    res = await db.execute(
        select(Notification).where(
            Notification.recipient_user_id == recipient_id,
            Notification.category == "mention",
        )
    )
    return list(res.scalars().all())


# --------------------------------------------------------------------------- #
# Card description — PATCH adds a @mention node
# --------------------------------------------------------------------------- #
async def test_patch_card_description_with_mention_notifies_member_not_actor(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    mentioned_member: User,
):
    resp = await client.patch(
        f"{CARDS_BASE}/{test_board.id}/cards/{test_card.id}",
        json={"description": _mention_doc(mentioned_member.id)},
    )
    assert resp.status_code == 200

    assert len(await _mention_rows(db_session, mentioned_member.id)) == 1
    # The actor (test_user) must NOT be notified for their own mention action.
    assert await _mention_rows(db_session, test_user.id) == []


async def test_create_card_with_mention_in_description_notifies_member(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    mentioned_member: User,
):
    resp = await client.post(
        f"{CARDS_BASE}/{test_board.id}/cards",
        json={
            "title": "Card with mention",
            "column_id": str(test_column.id),
            "description": _mention_doc(mentioned_member.id),
        },
    )
    assert resp.status_code == 201
    assert len(await _mention_rows(db_session, mentioned_member.id)) == 1
    assert await _mention_rows(db_session, test_user.id) == []


# --------------------------------------------------------------------------- #
# Note content — create + update add a @mention node
# --------------------------------------------------------------------------- #
async def test_create_board_note_with_mention_notifies_member(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    mentioned_member: User,
):
    resp = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/notes",
        json={"title": "Note", "content": _mention_doc(mentioned_member.id)},
    )
    assert resp.status_code == 201
    assert len(await _mention_rows(db_session, mentioned_member.id)) == 1
    assert await _mention_rows(db_session, test_user.id) == []


async def test_update_board_note_adds_mention_notifies_member(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    mentioned_member: User,
):
    # Create a note WITHOUT a mention first.
    create = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/notes",
        json={"title": "Plain note", "content": "no mentions yet"},
    )
    assert create.status_code == 201
    note_id = create.json()["id"]
    # No mention notif yet.
    assert await _mention_rows(db_session, mentioned_member.id) == []

    # Update to ADD the mention.
    update = await client.put(
        f"/api/workspaces/default/boards/{test_board.id}/notes/{note_id}",
        json={"content": _mention_doc(mentioned_member.id)},
    )
    assert update.status_code == 200

    assert len(await _mention_rows(db_session, mentioned_member.id)) == 1
    assert await _mention_rows(db_session, test_user.id) == []
