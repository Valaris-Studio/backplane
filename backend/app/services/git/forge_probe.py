# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""ForgeProbe — "does this token identify anyone, and as whom?"

A PAT is opaque: the operator pastes a string and we have no idea which account
it belongs to, whether it is already revoked, or whether it can reach the host
at all. Storing it unverified means the failure surfaces later, inside a merge
worker, as an unattributable 401. So every write path probes first and stores
only what the forge itself confirmed.

The probe is a dependency (get_forge_probe) rather than a direct httpx call so
tests inject a fake — no live network in the suite.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from app.models.git.git_repo import GitProvider

_PROBE_TIMEOUT_SECONDS = 10.0


class ProbeError(Exception):
    """Base for probe failures. The message is shown to operators verbatim."""


class ProbeUnauthorized(ProbeError):
    """The host answered, and rejected the token."""


class ProbeUnreachable(ProbeError):
    """The host never answered — DNS, TLS, timeout, or a 5xx."""


class ProbeUnsupportedProvider(ProbeError):
    """No probe implementation for this provider."""


@dataclass(frozen=True)
class ProbeIdentity:
    """What the forge told us about the token. Nothing here is inferred.

    `scopes` is empty when the forge does not disclose them — GitHub
    fine-grained PATs return no X-OAuth-Scopes header at all. Empty means
    "unknown", never "none": we record what is discoverable and let the
    verify endpoint say so rather than fabricating certainty.
    """

    account_login: str
    account_type: str
    scopes: list[str] = field(default_factory=list)


def _normalize_account_type(raw: str | None) -> str:
    # git_connections.account_type is CHECK-constrained to these two.
    return "organization" if (raw or "").lower() == "organization" else "user"


class ForgeProbe:
    """Interface. Subclasses (and test fakes) implement `probe`."""

    async def probe(
        self, *, provider: GitProvider, token: str, base_url: str | None
    ) -> ProbeIdentity:
        raise NotImplementedError


class HttpForgeProbe(ForgeProbe):
    """Real probe: one authenticated GET at each forge's "who am I" endpoint."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self._transport = transport

    async def probe(
        self, *, provider: GitProvider, token: str, base_url: str | None
    ) -> ProbeIdentity:
        if provider is GitProvider.github:
            return await self._probe_github(token, base_url)
        if provider is GitProvider.gitlab:
            return await self._probe_gitlab(token, base_url)
        if provider is GitProvider.gitea:
            return await self._probe_gitea(token, base_url)
        raise ProbeUnsupportedProvider(
            f"Backplane cannot verify {provider.value} tokens yet. Supported "
            "providers are github, gitlab and gitea."
        )

    async def _get(self, url: str, headers: dict[str, str]) -> httpx.Response:
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=_PROBE_TIMEOUT_SECONDS
            ) as client:
                return await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise ProbeUnreachable(
                f"Could not reach {url}: {exc.__class__.__name__}. Check the "
                "base URL and that the host is reachable from Backplane."
            ) from exc

    def _guard_status(
        self, response: httpx.Response, *, provider: str, url: str
    ) -> None:
        if response.status_code in (401, 403):
            raise ProbeUnauthorized(
                f"The {provider} host rejected this token "
                f"(HTTP {response.status_code}). Check that the token is not "
                "expired or revoked, and that it grants read access to the "
                "account."
            )
        if response.status_code >= 400:
            raise ProbeUnreachable(
                f"{url} answered HTTP {response.status_code}. Check the base "
                "URL points at the forge's API root."
            )

    async def _probe_github(
        self, token: str, base_url: str | None
    ) -> ProbeIdentity:
        api_root = (base_url or "https://api.github.com").rstrip("/")
        url = f"{api_root}/user"
        response = await self._get(
            url,
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
        self._guard_status(response, provider="GitHub", url=url)
        payload = response.json()
        # Classic PATs advertise their scopes here; fine-grained tokens omit
        # the header entirely, which is why an empty list must read as
        # "undisclosed" downstream rather than "no permissions".
        raw_scopes = response.headers.get("X-OAuth-Scopes", "")
        scopes = [s.strip() for s in raw_scopes.split(",") if s.strip()]
        return ProbeIdentity(
            account_login=payload.get("login", ""),
            account_type=_normalize_account_type(payload.get("type")),
            scopes=scopes,
        )

    async def _probe_gitlab(
        self, token: str, base_url: str | None
    ) -> ProbeIdentity:
        api_root = (base_url or "https://gitlab.com").rstrip("/")
        url = f"{api_root}/api/v4/user"
        response = await self._get(url, {"Authorization": f"Bearer {token}"})
        self._guard_status(response, provider="GitLab", url=url)
        payload = response.json()
        return ProbeIdentity(
            account_login=payload.get("username", ""),
            account_type="user",
            scopes=list(payload.get("scopes") or []),
        )

    async def _probe_gitea(
        self, token: str, base_url: str | None
    ) -> ProbeIdentity:
        if not base_url:
            raise ProbeUnsupportedProvider(
                "A gitea connection needs a base_url — there is no default "
                "gitea host."
            )
        url = f"{base_url.rstrip('/')}/api/v1/user"
        response = await self._get(url, {"Authorization": f"token {token}"})
        self._guard_status(response, provider="Gitea", url=url)
        payload = response.json()
        return ProbeIdentity(
            account_login=payload.get("login", ""),
            account_type="user",
            scopes=[],
        )


def get_forge_probe() -> ForgeProbe:
    """FastAPI dependency — overridden in tests with a fake."""
    return HttpForgeProbe()
