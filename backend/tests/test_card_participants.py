# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


async def test_remove_card_participant_returns_204_when_not_a_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Idempotent remove: deleting a non-participant is a no-op (204), not 404.

    Multi-role agent flows may try to unassign a participant that another role
    already removed; per feedback_idempotent_mutations.md, that must succeed.
    """
    response = await client.delete(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants/{second_user.id}",
    )
    assert response.status_code == 204
