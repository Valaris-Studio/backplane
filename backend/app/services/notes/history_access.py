# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

from app.core.auth import (
    current_agent_id, current_api_key_id, current_api_key_installation_id,
    current_authentication_method,
)
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.workspace import WorkspaceRole
from app.repositories.notes.history_access import NoteHistoryAccessRepository
from app.repositories.notes.note import NoteRepository


class NoteHistoryAccess:
    def __init__(self, db):
        self.repo = NoteHistoryAccessRepository(db)
        self.notes = NoteRepository(db)

    async def authorize(self, workspace_id, user_id, *, write=False):
        # Internal services may lack a request actor. That is unknown provenance,
        # not evidence of an end-user identity or permission to read history.
        if user_id is None:
            return None
        membership = await self.repo.membership(workspace_id, user_id)
        if membership is None or (write and membership.role == WorkspaceRole.viewer):
            raise ForbiddenError("Insufficient workspace access")
        key_id, agent_id = current_api_key_id.get(), current_agent_id.get()
        installation_id = current_api_key_installation_id.get()
        key = await self.repo.key(key_id) if key_id else None
        if key_id and (key is None or key.user_id != user_id or key.installation_id != installation_id):
            raise ForbiddenError("Credential is no longer authorized")
        agent = await self.repo.agent(agent_id) if agent_id else None
        if agent_id and (agent is None or not agent.is_active or agent.api_key_id != key_id
                         or (agent.allowed_workspaces and membership.slug not in agent.allowed_workspaces)):
            raise ForbiddenError("Agent is no longer authorized")
        installation = await self.repo.installation(installation_id) if installation_id else None
        if installation_id and (installation is None or installation.owner_id != user_id or installation.revoked_at):
            raise ForbiddenError("Installation is no longer authorized")
        return {
            "user_id": str(user_id), "user_name": await self.repo.user_name(user_id),
            "authentication_method": current_authentication_method.get(),
            "principal_kind": "agent" if agent_id else "installation" if installation_id else "user",
            "agent_id": str(agent_id) if agent_id else None,
            "agent_name": agent.name if agent else None,
            "api_key_id": str(key_id) if key_id else None,
            "api_key_name": key.name if key else None,
            "installation_id": str(installation_id) if installation_id else None,
        }

    async def note_scope(self, note_id, workspace_id, user_id, *, board_id=None, write=False):
        await self.authorize(workspace_id, user_id, write=write)
        scope = await self.notes.get_scope(note_id)
        if scope is None or scope.workspace_id != workspace_id or (board_id is not None and scope.board_id != board_id):
            raise ResourceNotFoundError("Note not found")
        return scope

    @staticmethod
    def principal_key(user_id):
        return json.dumps([str(value) if value else None for value in (
            user_id, current_agent_id.get(), current_api_key_id.get(),
            current_api_key_installation_id.get(),
        )], separators=(",", ":"))
