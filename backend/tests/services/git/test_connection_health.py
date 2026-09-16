# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Connection health bookkeeping written by credential CONSUMERS.

`verify_connection` records health when an operator asks for it. These two
methods record it when a background consumer (merge worker, done-gate,
reconciler, scheduler) discovers the same truth the hard way — a 401/403 from
the forge while actually using the credential. The operator then sees "this
connection is broken" on the connections list without having to re-probe.

The contract that matters most here is that neither method may raise: they run
inside a merge attempt's exception path, and a health-write failure must never
become the error the operator sees instead of the real one.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace
from app.services.git.git_connection import GitConnectionService


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


async def _make_connection(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    last_error: str | None = None,
) -> GitConnection:
    connection = GitConnection(
        workspace_id=workspace.id,
        provider=GitProvider.github,
        account_login="acme-bot",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_secret"),
        scopes=["repo"],
        connected_by=user.id,
        last_error=last_error,
    )
    db.add(connection)
    await db.flush()
    return connection


def _service(db: AsyncSession) -> GitConnectionService:
    return GitConnectionService(db, vault=_vault())


@pytest.mark.asyncio
async def test_record_auth_failure_stores_message_on_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    connection = await _make_connection(db_session, test_workspace, test_user)

    await _service(db_session).record_auth_failure(
        connection.id, "gh pr merge failed (rc=1): HTTP 401 Bad credentials"
    )

    refreshed = await db_session.get(GitConnection, connection.id)
    assert refreshed.last_error == (
        "gh pr merge failed (rc=1): HTTP 401 Bad credentials"
    )


@pytest.mark.asyncio
async def test_record_auth_failure_leaves_last_verified_at_alone(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """last_verified_at answers "when did a probe last succeed" — a consumer's
    401 does not un-happen that probe, it just adds a newer failure."""
    from datetime import datetime

    connection = await _make_connection(db_session, test_workspace, test_user)
    verified_at = datetime(2026, 8, 1, 12, 0, 0)
    connection.last_verified_at = verified_at
    await db_session.flush()

    await _service(db_session).record_auth_failure(connection.id, "401 Unauthorized")

    refreshed = await db_session.get(GitConnection, connection.id)
    assert refreshed.last_verified_at == verified_at
    assert refreshed.last_error == "401 Unauthorized"


@pytest.mark.asyncio
async def test_record_auth_failure_truncates_long_messages(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    connection = await _make_connection(db_session, test_workspace, test_user)

    await _service(db_session).record_auth_failure(connection.id, "x" * 5000)

    refreshed = await db_session.get(GitConnection, connection.id)
    assert len(refreshed.last_error) <= 500


@pytest.mark.asyncio
async def test_record_auth_failure_redacts_embedded_credentials(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """git echoes the whole clone URL on an auth failure — writing that
    verbatim would persist the very token that just failed."""
    connection = await _make_connection(db_session, test_workspace, test_user)

    await _service(db_session).record_auth_failure(
        connection.id,
        "fatal: could not read from "
        "https://x-access-token:ghp_REALSECRET@github.com/acme/widgets.git",
    )

    refreshed = await db_session.get(GitConnection, connection.id)
    assert "ghp_REALSECRET" not in refreshed.last_error
    assert "***@github.com" in refreshed.last_error


@pytest.mark.asyncio
async def test_record_auth_failure_unknown_connection_is_a_noop(
    db_session: AsyncSession
):
    """A connection deleted mid-merge must not turn into an exception on the
    hot path."""
    await _service(db_session).record_auth_failure(uuid.uuid4(), "401")


@pytest.mark.asyncio
async def test_record_auth_success_clears_last_error(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    connection = await _make_connection(
        db_session, test_workspace, test_user, last_error="401 Unauthorized"
    )

    await _service(db_session).record_auth_success(connection.id)

    refreshed = await db_session.get(GitConnection, connection.id)
    assert refreshed.last_error is None


@pytest.mark.asyncio
async def test_record_auth_success_on_healthy_connection_writes_nothing(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Every successful merge would otherwise UPDATE the row (and bump
    updated_at) purely to write NULL over NULL."""
    connection = await _make_connection(db_session, test_workspace, test_user)
    before = connection.updated_at

    await _service(db_session).record_auth_success(connection.id)

    refreshed = await db_session.get(GitConnection, connection.id)
    assert refreshed.last_error is None
    assert refreshed.updated_at == before


@pytest.mark.asyncio
async def test_record_auth_success_unknown_connection_is_a_noop(
    db_session: AsyncSession
):
    await _service(db_session).record_auth_success(uuid.uuid4())
