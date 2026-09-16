# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CredentialResolver — the single seam from a GitRepo to a usable forge token.

Every consumer that needs to authenticate against a repo's forge (merge
executor, Done-gate, PR sync, runner handoff) goes through here instead of
reading settings.GITHUB_TOKEN directly. Two reasons:

1. Workspaces own their credentials. A repo's bound git_connection beats the
   platform's env token, so one deployment can serve tenants whose forges the
   platform has no account on.
2. HOST MATCHING IS ENFORCED HERE, and only here. A token is returned only if
   the repo URL's host is the host that token was issued for. Downstream code
   embeds the token into the clone URL, so an unmatched token is an
   exfiltration primitive: point a repo at attacker.example.com, let the merge
   worker clone it, and the platform hands over its GitHub PAT. Resolving and
   host-checking in one place is what makes that impossible to forget.

When no credential is available the result carries a machine-readable `reason`
plus a `detail` written for an operator who knows nothing about the internals —
these strings surface in the UI and are the only thing standing between a
wedged merge queue and a support ticket.
"""

from __future__ import annotations

import enum
import re
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import config as _config
from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider, GitRepo

# Forge -> userinfo username used when embedding a token in an HTTPS clone URL.
# Mirrors merge_executor's convention: GitHub wants `x-access-token`, everyone
# else (GitLab, Gitea, Forgejo, Bitbucket, self-hosted) takes the universal
# `oauth2` form with the token as the password.
_GITHUB_USERINFO_USERNAME = "x-access-token"
_NONGITHUB_USERINFO_USERNAME = "oauth2"

# Where a provider lives when the connection names no base_url. Gitea is
# absent on purpose: there is no canonical gitea host, so a gitea connection
# without base_url cannot be host-matched and never yields a credential.
_PROVIDER_DEFAULT_HOST = {
    GitProvider.github: "github.com",
    GitProvider.gitlab: "gitlab.com",
    GitProvider.bitbucket: "bitbucket.org",
}

# scp-style shorthand (`git@github.com:acme/repo.git`) carries no scheme, so
# urlsplit reads the whole thing as a path. Matches the accepted form in
# schemas/git/git_repo.py.
_SCP_URL = re.compile(r"^[A-Za-z0-9._~-]+@(?P<host>[A-Za-z0-9.-]+):(?P<path>[^\s]+)$")


class ResolutionReason(str, enum.Enum):
    """Why no credential came back. Values are stable — the UI keys off them."""

    no_connection = "no_connection"
    ambiguous_connections = "ambiguous_connections"
    host_mismatch = "host_mismatch"
    fallback_disabled = "fallback_disabled"
    provider_has_no_fallback = "provider_has_no_fallback"
    unparseable_repo_url = "unparseable_repo_url"


@dataclass(frozen=True)
class ForgeCredential:
    token: str
    provider: GitProvider
    host: str
    username: str
    source: str
    connection_id: uuid.UUID | None


@dataclass(frozen=True)
class CredentialResolution:
    credential: ForgeCredential | None
    reason: ResolutionReason | None = None
    detail: str = ""


def _userinfo_username(provider: GitProvider | str) -> str:
    value = provider.value if isinstance(provider, GitProvider) else provider
    return (
        _GITHUB_USERINFO_USERNAME
        if value == GitProvider.github.value
        else _NONGITHUB_USERINFO_USERNAME
    )


def _normalize_host(host: str | None) -> str | None:
    """Fold a host to its comparison form: lowercase, no `www.`, port kept.

    The port stays because `git.acme.dev:8080` and `:9090` are different
    origins — one's token must not authenticate against the other.
    """
    if not host:
        return None
    normalized = host.strip().lower().rstrip(".")
    if normalized.startswith("www."):
        normalized = normalized[4:]
    return normalized or None


def _host_from_url(url: str | None) -> str | None:
    """Extract the comparison host from a git URL, or None if unparseable.

    Userinfo is stripped by urlsplit's own parsing, so
    `https://github.com@evil.example.com/x` resolves to evil.example.com —
    the host git actually contacts, which is the one that must be matched.
    """
    if not url:
        return None
    candidate = url.strip()
    if not candidate:
        return None

    parts = urlsplit(candidate)
    if parts.scheme and parts.netloc:
        try:
            hostname = parts.hostname
        except ValueError:  # malformed IPv6 literal / bad port
            return None
        normalized = _normalize_host(hostname)
        if normalized is None:
            return None
        try:
            port = parts.port
        except ValueError:
            return None
        return f"{normalized}:{port}" if port is not None else normalized

    if match := _SCP_URL.match(candidate):
        return _normalize_host(match.group("host"))
    return None


def _connection_host(connection: GitConnection) -> str | None:
    if connection.base_url:
        return _host_from_url(connection.base_url)
    provider = connection.provider
    if not isinstance(provider, GitProvider):
        try:
            provider = GitProvider(provider)
        except ValueError:
            return None
    return _PROVIDER_DEFAULT_HOST.get(provider)


class CredentialResolver:
    """Resolves a repo to the credential that may authenticate against it.

    Chain, first match wins:
      1. the connection the repo is explicitly bound to (git_repos.connection_id)
      2. the workspace's sole connection for the repo's provider
      3. the platform's env token, if ALLOW_GLOBAL_TOKEN_FALLBACK
    Every branch is host-checked before it yields a credential.
    """

    def __init__(self, db: AsyncSession, *, vault: FernetTokenVault | None = None):
        self.db = db
        self.vault = vault or FernetTokenVault(
            _config.settings.INTEGRATIONS_TOKEN_KEY.encode()
        )

    async def resolve(self, git_repo: GitRepo) -> CredentialResolution:
        repo_host = _host_from_url(git_repo.url)
        if repo_host is None:
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.unparseable_repo_url,
                detail=(
                    f"Cannot determine a host from the repository URL "
                    f"{git_repo.url!r}, so no credential can be safely matched to "
                    "it. Fix the repository URL in board settings."
                ),
            )

        provider = git_repo.provider
        if not isinstance(provider, GitProvider):
            provider = GitProvider(provider)

        if git_repo.connection_id is not None:
            bound = await self._get_connection(
                git_repo.connection_id, git_repo.workspace_id
            )
            if bound is not None:
                return self._from_connection(bound, provider, repo_host)

        candidates = await self._list_connections(git_repo.workspace_id, provider)
        if len(candidates) == 1:
            return self._from_connection(candidates[0], provider, repo_host)
        if len(candidates) > 1:
            logins = ", ".join(sorted(c.account_login for c in candidates))
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.ambiguous_connections,
                detail=(
                    f"This workspace has {len(candidates)} {provider.value} "
                    f"connections ({logins}) and this repository is not bound to "
                    "any of them, so it is not clear which credential to use. "
                    "Pick one on the repository in board settings."
                ),
            )

        return self._from_global_fallback(provider, repo_host)

    async def _get_connection(
        self, connection_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> GitConnection | None:
        result = await self.db.execute(
            select(GitConnection).where(
                GitConnection.id == connection_id,
                GitConnection.workspace_id == workspace_id,
            )
        )
        return result.scalar_one_or_none()

    async def _list_connections(
        self, workspace_id: uuid.UUID, provider: GitProvider
    ) -> list[GitConnection]:
        result = await self.db.execute(
            select(GitConnection).where(
                GitConnection.workspace_id == workspace_id,
                GitConnection.provider == provider.value,
            )
        )
        return list(result.scalars().all())

    def _from_connection(
        self, connection: GitConnection, provider: GitProvider, repo_host: str
    ) -> CredentialResolution:
        conn_host = _connection_host(connection)
        if conn_host is None:
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.host_mismatch,
                detail=(
                    f"Connection '{connection.account_login}' has no base_url, and "
                    f"{provider.value} has no default host, so there is no way to "
                    f"tell whether its token belongs to '{repo_host}'. Set the "
                    "connection's base_url in workspace settings."
                ),
            )
        if not _hosts_match(conn_host, repo_host):
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.host_mismatch,
                detail=(
                    f"Repo host '{repo_host}' does not match connection "
                    f"'{connection.account_login}' ({conn_host}). Bind a "
                    "connection for this host in workspace settings."
                ),
            )
        return CredentialResolution(
            credential=ForgeCredential(
                token=self.vault.decrypt(connection.encrypted_access_token),
                provider=provider,
                host=repo_host,
                username=_userinfo_username(provider),
                source=f"workspace connection {connection.account_login}",
                connection_id=connection.id,
            )
        )

    def _from_global_fallback(
        self, provider: GitProvider, repo_host: str
    ) -> CredentialResolution:
        settings = _config.settings
        token, token_host = _global_token_for_provider(provider, settings)

        if token_host is None:
            # This provider has no usable env token: either none is set, or one
            # exists whose host we cannot determine (GITEA_TOKEN). Separate
            # reasons because the operator's next move differs — "nothing is
            # configured anywhere" vs "the platform token cannot serve this
            # provider, so this workspace must bring its own".
            platform_has_any_token = _platform_has_any_token(settings)
            return CredentialResolution(
                credential=None,
                reason=(
                    ResolutionReason.provider_has_no_fallback
                    if platform_has_any_token
                    else ResolutionReason.no_connection
                ),
                detail=_no_fallback_detail(provider, repo_host, has_token=bool(token)),
            )

        if not getattr(settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", True):
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.fallback_disabled,
                detail=(
                    "The platform-wide token fallback is disabled on this "
                    f"deployment, and no workspace connection covers "
                    f"'{repo_host}'. Add a {provider.value} connection in "
                    "workspace settings."
                ),
            )

        if not _hosts_match(token_host, repo_host):
            return CredentialResolution(
                credential=None,
                reason=ResolutionReason.host_mismatch,
                detail=(
                    f"Repo host '{repo_host}' does not match the platform "
                    f"{provider.value} token's host ({token_host}), and this "
                    "workspace has no connection for that host. Add one in "
                    "workspace settings."
                ),
            )

        return CredentialResolution(
            credential=ForgeCredential(
                token=token,
                provider=provider,
                host=repo_host,
                username=_userinfo_username(provider),
                source="platform token",
                connection_id=None,
            )
        )


def _hosts_match(left: str, right: str) -> bool:
    return _normalize_host(left) == _normalize_host(right)


def _global_token_for_provider(
    provider: GitProvider, settings
) -> tuple[str, str | None]:
    """The env token for `provider` and the host it was issued for.

    A host of None means "never usable": either no token is set, or the token
    exists but nothing tells us which host it belongs to (GITEA_TOKEN), and a
    token we cannot place is a token we must not embed in a URL.

    Note there is no cross-provider fallback here — the old merge_executor
    handed GITHUB_TOKEN to gitlab/gitea repos, which is exactly the "token
    reaches a host that never issued it" bug this resolver exists to close.
    """
    if provider is GitProvider.github:
        token = getattr(settings, "GITHUB_TOKEN", "") or ""
        if not token:
            return "", None
        api_host = _host_from_url(getattr(settings, "GITHUB_API_URL", "") or "")
        # api.github.com issues tokens for github.com; every GHE deployment
        # serves both the API and the git remotes off one host.
        if api_host == "api.github.com":
            api_host = "github.com"
        return token, api_host or "github.com"

    if provider is GitProvider.gitlab:
        token = getattr(settings, "GITLAB_TOKEN", "") or ""
        return (token, "gitlab.com") if token else ("", None)

    if provider is GitProvider.gitea:
        # GITEA_TOKEN names no host — there is no canonical gitea instance.
        return (getattr(settings, "GITEA_TOKEN", "") or ""), None

    return "", None


def _platform_has_any_token(settings) -> bool:
    return any(
        getattr(settings, name, "")
        for name in ("GITHUB_TOKEN", "GITLAB_TOKEN", "GITEA_TOKEN")
    )


def _no_fallback_detail(
    provider: GitProvider, repo_host: str, *, has_token: bool
) -> str:
    if has_token:
        return (
            f"The platform has a {provider.value} token but no way to tell which "
            f"host it belongs to, so it will not be used for '{repo_host}'. "
            f"Create a {provider.value} connection with base_url "
            f"'https://{repo_host}' in workspace settings."
        )
    return (
        f"No {provider.value} credential is available for '{repo_host}': this "
        f"workspace has no {provider.value} connection and the platform has no "
        f"{provider.value} token configured. Add a connection in workspace "
        "settings."
    )
