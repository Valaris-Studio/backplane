# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timezone

from sqlalchemy import select

from app.models.kanban.completion import CompletionAttempt, CompletionCandidate


class CompletionContextRepository:
    def __init__(self, db):
        self.db = db

    async def active_attempts(self, workspace_id):
        return list(await self.db.scalars(select(CompletionAttempt).join(
            CompletionCandidate, CompletionAttempt.candidate_id == CompletionCandidate.id
        ).where(
            CompletionAttempt.workspace_id == workspace_id,
            CompletionCandidate.workspace_id == workspace_id,
            CompletionCandidate.is_current.is_(True),
            CompletionAttempt.status == "claimed",
            CompletionAttempt.expires_at > datetime.now(timezone.utc).replace(tzinfo=None),
        ).order_by(CompletionAttempt.created_at, CompletionAttempt.id)))
