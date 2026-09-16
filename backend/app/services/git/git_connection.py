# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GitConnectionService — encryption + workspace authorization.

LAYER: integrations (provider-agnostic, OAuth, multi-provider). The legacy
single-token GITHUB_TOKEN path lives in app/services/github_client.py and is
still used by hot paths (Done-gate, card service); new OAuth-backed
connections route through here.

Reconnects are upserts on (workspace_id, provider, account_login) — the
OAuth callback may fire multiple times (browser back-button, double-click,
LLM retry) and must converge to a single row with the freshest tokens
rather than 409-ing.
"""

import logging
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.integrations.git.vault import FernetTokenVault
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.repositories.git.git_connection import GitConnectionRepository
from app.schemas.git.git_connection import (
    ConnectionCheck,
    GitConnectionCreateInternal,
    GitConnectionPatCreate,
    GitConnectionRead,
    GitConnectionVerifyResult,
)
from app.services.activity import ActivityService
from app.services.git.forge_probe import (
    ForgeProbe,
    ProbeError,
    ProbeIdentity,
)
from app.services.git.redaction import redact_url_credentials
from app.utils import utcnow

logger = logging.getLogger(__name__)

# git_connections.last_error is String(1024); consumers pass raw subprocess
# stderr, which can be arbitrarily long. Truncate well inside the column so a
# multi-line git dump can never fail the write it exists to record.
_LAST_ERROR_MAX_CHARS = 500

# What each forge must let the platform do to run a merge queue and read CI.
# Keyed by the scope string a CLASSIC token advertises; fine-grained GitHub
# tokens disclose nothing, so these are reported as "undisclosed" rather than
# failed — see _scope_checks.
_REQUIRED_SCOPES = {
    GitProvider.github: {
        "repo": (
            "Grants Contents read/write and Pull requests read/write — the "
            "merge queue needs both to push branches and merge PRs."
        ),
    },
    GitProvider.gitlab: {
        "api": "Full API access — needed to push branches and accept merge requests.",
    },
}

_GITHUB_FINE_GRAINED_GUIDANCE = (
    "This token does not disclose its scopes, which is normal for a GitHub "
    "fine-grained PAT. Confirm by hand that it grants: Contents read/write, "
    "Pull requests read/write, Actions read, and Commit statuses read. "
    "(Backplane reads Actions runs rather than the Checks API, because the "
    "Checks API is only available to GitHub Apps, not to PATs.)"
)


def _build_checks(
    provider: GitProvider, identity: ProbeIdentity
) -> list[ConnectionCheck]:
    """Turn a probe result into per-duty checks an operator can act on.

    Scope reporting is honest about uncertainty: when the forge disclosed no
    scopes we say so and name what to confirm by hand, rather than reporting a
    pass we cannot substantiate or a failure that would be wrong for every
    GitHub fine-grained token.
    """
    checks = [
        ConnectionCheck(
            name="identity",
            ok=True,
            guidance=(
                f"Authenticated as '{identity.account_login}' "
                f"({identity.account_type})."
            ),
        )
    ]

    required = _REQUIRED_SCOPES.get(provider, {})
    if not identity.scopes:
        checks.append(
            ConnectionCheck(
                name="scopes",
                ok=False,
                guidance=(
                    _GITHUB_FINE_GRAINED_GUIDANCE
                    if provider is GitProvider.github
                    else (
                        f"This {provider.value} host did not disclose the "
                        "token's scopes. Confirm by hand that it can read and "
                        "write repository contents and pull/merge requests."
                    )
                ),
            )
        )
        return checks

    for scope, why in required.items():
        checks.append(
            ConnectionCheck(
                name=f"scope:{scope}",
                ok=scope in identity.scopes,
                guidance=(
                    why
                    if scope in identity.scopes
                    else f"Missing '{scope}' scope. {why} Re-issue the token with it."
                ),
            )
        )

    if provider is GitProvider.github:
        # The merge queue reads CI state from Actions runs. The Checks API
        # would be the natural source but is Apps-only — a PAT can never call
        # it, so `workflow` is what actually matters here.
        checks.append(
            ConnectionCheck(
                name="ci-read",
                ok="workflow" in identity.scopes or "repo" in identity.scopes,
                guidance=(
                    "Backplane reads CI state from Actions workflow runs "
                    "(the Checks API is available to GitHub Apps only, not to "
                    "personal access tokens). The 'repo' scope covers this for "
                    "classic tokens; fine-grained tokens need Actions: read "
                    "and Commit statuses: read."
                ),
            )
        )
    return checks


def _scopes_confirmed(checks: list[ConnectionCheck]) -> bool:
    """Collapse the per-duty checks into the one bit the list view can show.

    Identity is excluded deliberately: a probe that got this far already
    proved identity, and a failing identity check never reaches here. What
    remains is exactly the permission question — did the forge substantiate
    everything the merge queue needs? Undisclosed scopes are reported as a
    failing check, so both "we cannot tell" and "a required scope is absent"
    collapse to False, which is the same warning to the operator: nobody has
    proven this credential can push and merge.
    """
    return all(check.ok for check in checks if check.name != "identity")


class GitConnectionService:
    def __init__(self, db: AsyncSession, *, vault: FernetTokenVault):
        self.db = db
        self.repo = GitConnectionRepository(db)
        self.vault = vault

    async def create_connection(
        self, payload: GitConnectionCreateInternal
    ) -> GitConnectionRead:
        encrypted_access = self.vault.encrypt(payload.access_token)
        encrypted_refresh = (
            self.vault.encrypt(payload.refresh_token)
            if payload.refresh_token is not None
            else None
        )
        connection = await self.repo.create(
            workspace_id=payload.workspace_id,
            provider=payload.provider,
            account_login=payload.account_login,
            account_type=payload.account_type,
            encrypted_access_token=encrypted_access,
            encrypted_refresh_token=encrypted_refresh,
            scopes=list(payload.scopes),
            expires_at=payload.expires_at,
            base_url=payload.base_url,
            connected_by=payload.connected_by,
        )
        return GitConnectionRead.model_validate(connection)

    async def create_or_update_connection(
        self,
        *,
        workspace_id: uuid.UUID,
        provider: GitProvider,
        account_login: str,
        account_type: str,
        access_token: str,
        refresh_token: str | None = None,
        scopes: list[str],
        expires_at: datetime | None = None,
        base_url: str | None = None,
        connected_by: uuid.UUID,
        auth_kind: str = "oauth",
        last_verified_at: datetime | None = None,
        last_error: str | None = None,
        scopes_confirmed: bool | None = None,
    ) -> tuple[GitConnectionRead, bool]:
        """Upsert on (workspace, provider, account_login).

        Returns (connection, created) so routers can answer 201 on a genuinely
        new connection and 200 on a re-submit.
        """
        existing = await self.repo.get_by_workspace_provider_login(
            workspace_id, provider, account_login
        )
        encrypted_access = self.vault.encrypt(access_token)
        encrypted_refresh = (
            self.vault.encrypt(refresh_token)
            if refresh_token is not None
            else None
        )
        if existing is not None:
            updated = await self.repo.update(
                existing,
                account_type=account_type,
                encrypted_access_token=encrypted_access,
                encrypted_refresh_token=encrypted_refresh,
                scopes=list(scopes),
                expires_at=expires_at,
                base_url=base_url,
                connected_by=connected_by,
                auth_kind=auth_kind,
                last_verified_at=last_verified_at,
                last_error=last_error,
                scopes_confirmed=scopes_confirmed,
            )
            return GitConnectionRead.model_validate(updated), False
        connection = await self.repo.create(
            workspace_id=workspace_id,
            provider=provider,
            account_login=account_login,
            account_type=account_type,
            encrypted_access_token=encrypted_access,
            encrypted_refresh_token=encrypted_refresh,
            scopes=list(scopes),
            expires_at=expires_at,
            base_url=base_url,
            connected_by=connected_by,
            auth_kind=auth_kind,
            last_verified_at=last_verified_at,
            last_error=last_error,
            scopes_confirmed=scopes_confirmed,
        )
        return GitConnectionRead.model_validate(connection), True

    async def create_pat_connection(
        self,
        *,
        workspace_id: uuid.UUID,
        data: GitConnectionPatCreate,
        actor_id: uuid.UUID,
        probe: ForgeProbe,
    ) -> tuple[GitConnectionRead, bool]:
        """Verify a PAT against its forge, then store it.

        Probing first is the whole point: a token that cannot say who it
        belongs to has no account_login to key the row on, and would surface
        its failure later inside a merge worker as an unattributable 401.
        """
        try:
            identity = await probe.probe(
                provider=data.provider, token=data.token, base_url=data.base_url
            )
        except ProbeError as exc:
            raise ValidationError(str(exc)) from exc

        if not identity.account_login:
            raise ValidationError(
                f"The {data.provider.value} host accepted this token but "
                "returned no account name, so Backplane cannot identify it. "
                "Check that the token grants read access to the account "
                "profile."
            )

        connection, created = await self.create_or_update_connection(
            workspace_id=workspace_id,
            provider=data.provider,
            account_login=identity.account_login,
            account_type=identity.account_type,
            access_token=data.token,
            scopes=list(identity.scopes),
            base_url=data.base_url,
            connected_by=actor_id,
            auth_kind="pat",
            # Naive UTC (utcnow, house style) — tz-aware values die in asyncpg
            # against the timezone-less columns.
            last_verified_at=utcnow(),
            last_error=None,
            scopes_confirmed=_scopes_confirmed(
                _build_checks(data.provider, identity)
            ),
        )
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.workspace,
            entity_id=connection.id,
            action=ActivityAction.created if created else ActivityAction.updated,
            summary=(
                f"connected {data.provider.value} account "
                f"'{identity.account_login}' via access token"
            ),
            message_key="activity.git_connection.connected",
            message_params={
                "provider": data.provider.value,
                "account_login": identity.account_login,
            },
            changes={"provider": data.provider.value, "auth_kind": "pat"},
        )
        return connection, created

    async def verify_connection(
        self,
        *,
        connection_id: uuid.UUID,
        workspace_id: uuid.UUID,
        probe: ForgeProbe,
    ) -> GitConnectionVerifyResult:
        """Re-probe a stored connection and report what it can and cannot do.

        A failed probe is a recorded outcome, not an error response: the caller
        asked for the connection's health and an unhealthy answer IS the
        health. The failure is persisted to last_error so the list view shows
        it without re-probing.
        """
        connection = await self._require_in_workspace(connection_id, workspace_id)
        provider = connection.provider
        if not isinstance(provider, GitProvider):
            provider = GitProvider(provider)
        token = self.vault.decrypt(connection.encrypted_access_token)

        try:
            identity = await probe.probe(
                provider=provider, token=token, base_url=connection.base_url
            )
        except ProbeError as exc:
            updated = await self.repo.update(connection, last_error=str(exc))
            return GitConnectionVerifyResult(
                connection=GitConnectionRead.model_validate(updated),
                checks=[
                    ConnectionCheck(
                        name="identity",
                        ok=False,
                        guidance=str(exc),
                    )
                ],
            )

        checks = _build_checks(provider, identity)
        updated = await self.repo.update(
            connection,
            account_login=identity.account_login or connection.account_login,
            account_type=identity.account_type,
            scopes=list(identity.scopes),
            last_verified_at=utcnow(),
            last_error=None,
            scopes_confirmed=_scopes_confirmed(checks),
        )
        return GitConnectionVerifyResult(
            connection=GitConnectionRead.model_validate(updated),
            checks=checks,
        )

    async def record_auth_failure(
        self, connection_id: uuid.UUID, message: str
    ) -> None:
        """Mark a connection unhealthy after a consumer got a 401/403 while
        USING it (merge worker, done-gate, reconciler, scheduler).

        `verify_connection` records what an operator's probe found; this
        records what the platform found in production, which is the stronger
        signal and the one that explains a wedged merge queue.

        `last_verified_at` is deliberately untouched: it answers "when did a
        probe last succeed", and a later 401 does not un-happen that probe.

        Never raises. Callers are on a hot path already handling a failure, and
        a health-write error must not replace the real one.
        """
        try:
            connection = await self.repo.get_by_id(connection_id)
            if connection is None:
                return
            await self.repo.update(
                connection,
                last_error=redact_url_credentials(message)[:_LAST_ERROR_MAX_CHARS],
            )
        except Exception:
            logger.warning(
                "could not record auth failure on git connection %s",
                connection_id,
                exc_info=True,
            )

    async def record_auth_success(self, connection_id: uuid.UUID) -> None:
        """Clear a connection's recorded failure after it authenticated fine.

        A no-op when nothing is recorded — otherwise every successful merge
        would UPDATE the row (bumping `updated_at`) just to write NULL over
        NULL. Never raises, for the same reason as `record_auth_failure`.
        """
        try:
            connection = await self.repo.get_by_id(connection_id)
            if connection is None or connection.last_error is None:
                return
            await self.repo.update(connection, last_error=None)
        except Exception:
            logger.warning(
                "could not clear auth failure on git connection %s",
                connection_id,
                exc_info=True,
            )

    async def list_connections(
        self, workspace_id: uuid.UUID
    ) -> list[GitConnectionRead]:
        rows = await self.repo.list_by_workspace(workspace_id)
        return [GitConnectionRead.model_validate(row) for row in rows]

    async def delete_connection(
        self,
        connection_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> None:
        """Delete a connection. Already-gone is success, not 404 — agents retry
        deletes and a second 204 is the honest answer to "make it not exist".
        """
        connection = await self.repo.get_by_id(connection_id)
        if connection is None or connection.workspace_id != workspace_id:
            return
        account_login = connection.account_login
        provider = connection.provider
        await self.repo.delete(connection)
        if actor_id is not None:
            await ActivityService(self.db).record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.workspace,
                entity_id=connection_id,
                action=ActivityAction.deleted,
                summary=(
                    f"disconnected {provider.value if isinstance(provider, GitProvider) else provider} "
                    f"account '{account_login}'"
                ),
                message_key="activity.git_connection.disconnected",
                message_params={
                    "provider": provider.value
                    if isinstance(provider, GitProvider)
                    else provider,
                    "account_login": account_login,
                },
            )

    async def get_decrypted_access_token(
        self, connection_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> str:
        connection = await self._require_in_workspace(connection_id, workspace_id)
        return self.vault.decrypt(connection.encrypted_access_token)

    async def _require_in_workspace(
        self, connection_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> GitConnection:
        connection = await self.repo.get_by_id(connection_id)
        if not connection or connection.workspace_id != workspace_id:
            raise ResourceNotFoundError("Git connection not found")
        return connection
