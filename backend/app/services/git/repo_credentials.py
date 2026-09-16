# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The read-only consumers' view of CredentialResolver.

The merge executor needs a clone URL and a GH_TOKEN. The Done-gate, the
merged-PR reconciler, and the scheduler's open-PR preconditions need something
smaller: a token to construct a GitHubClient with, an explanation when there
isn't one, and a place to record that the token turned out to be bad.

All three share one posture — SOFT-PASS. None of them may hard-fail on a
missing credential: a card would wedge in review, or every workspace without a
configured token would deadlock the scheduler. What changes here is that the
soft-pass now says WHICH repo lacked a credential and what to do about it,
instead of a once-per-process "GITHUB_TOKEN is unset".
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git.git_repo import GitRepo
from app.services.git.credential_resolver import CredentialResolver

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RepoCredential:
    """A repo's forge token, or the reason there isn't one.

    `record_failure` / `record_success` are no-ops unless the token came from a
    workspace connection — the platform token has no row to mark, and neither
    does an absent credential.
    """

    token: str | None
    connection_id: uuid.UUID | None
    reason: str | None
    detail: str

    async def record_failure(self, db: AsyncSession, message: str) -> None:
        if self.connection_id is None:
            return
        await _connection_service(db).record_auth_failure(self.connection_id, message)

    async def record_success(self, db: AsyncSession) -> None:
        if self.connection_id is None:
            return
        await _connection_service(db).record_auth_success(self.connection_id)

    def warn(self, what: str, **context) -> None:
        """Log the soft-pass with the resolution's own words.

        `detail` is written for an operator who knows nothing about the
        internals; it is the entire value of this over the old generic
        warning, so it always goes in the message.
        """
        logger.warning(
            "%s: no forge credential (%s) — %s%s",
            what,
            self.reason or "unknown",
            self.detail,
            "".join(f" {k}={v}" for k, v in context.items()),
        )


_NO_REPO = RepoCredential(
    token=None,
    connection_id=None,
    reason="no_repo",
    detail=(
        "This board has no git repository linked, so there is no forge to "
        "authenticate against. Link a repository in board settings."
    ),
)


class RepoCredentialLookup:
    """Resolve a board or repo to the credential its consumers should use."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def for_repo(self, repo: GitRepo) -> RepoCredential:
        resolution = await CredentialResolver(self.db).resolve(repo)
        credential = resolution.credential
        if credential is None:
            return RepoCredential(
                token=None,
                connection_id=None,
                reason=resolution.reason.value if resolution.reason else None,
                detail=resolution.detail,
            )
        return RepoCredential(
            token=credential.token,
            connection_id=credential.connection_id,
            reason=None,
            detail="",
        )

    async def for_board(self, board_id: uuid.UUID) -> RepoCredential:
        """The credential for the board's repo.

        Boards with no repo (ops/triage/doc boards) resolve to "no credential"
        rather than an error — every caller here soft-passes anyway, and such a
        board has no forge to talk to by construction. A board with several
        repos uses the first: these consumers ask one question about one PR,
        and the PR's host is what the resolver host-checks.
        """
        repo = (
            await self.db.execute(
                select(GitRepo).where(GitRepo.board_id == board_id).order_by(GitRepo.created_at)
            )
        ).scalars().first()
        if repo is None:
            return _NO_REPO
        return await self.for_repo(repo)


async def credential_for_repo(db: AsyncSession, repo: GitRepo) -> RepoCredential:
    return await RepoCredentialLookup(db).for_repo(repo)


async def credential_for_board(db: AsyncSession, board_id: uuid.UUID) -> RepoCredential:
    return await RepoCredentialLookup(db).for_board(board_id)


def _connection_service(db: AsyncSession):
    from app import config as _config
    from app.integrations.git.vault import FernetTokenVault
    from app.services.git.git_connection import GitConnectionService

    return GitConnectionService(
        db, vault=FernetTokenVault(_config.settings.INTEGRATIONS_TOKEN_KEY.encode())
    )
