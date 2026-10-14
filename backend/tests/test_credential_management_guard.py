# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Which callers may reach the agent-administration and credential routes.

Owner decision 2026-09-30: a companion installation's key carries its person's
full reach, except managing credentials. Registered Agent keys stay refused on
both lists. The lists are spelled out so a new route has to be placed on one
on purpose.
"""

import hashlib
import re
import secrets
import uuid

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient

from app.core.auth import forbid_agent_callers, forbid_credential_management
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey

AGENT_ADMINISTRATION_ROUTES = {
    ("POST", "/api/agents/{agent_id}/poll"),
    ("POST", "/api/agents/{agent_id}/restart"),
    ("POST", "/api/agents/{agent_id}/pause"),
    ("POST", "/api/agents/{agent_id}/resume"),
    ("PATCH", "/api/agents/{agent_id}"),
    ("DELETE", "/api/agents/{agent_id}/hard"),
    ("DELETE", "/api/agents/{agent_id}"),
    ("POST", "/api/workspaces/{slug}/teams"),
    ("PATCH", "/api/workspaces/{slug}/teams/{team_ident}"),
    ("DELETE", "/api/workspaces/{slug}/teams/{team_ident}"),
    ("POST", "/api/workspaces/{slug}/teams/{team_ident}/members"),
    ("DELETE", "/api/workspaces/{slug}/teams/{team_ident}/members/{agent_id}"),
    ("POST", "/api/workspaces/{slug}/approvals/{approval_id}/decide"),
    ("POST", "/api/workspaces"),
    ("PATCH", "/api/workspaces/{slug}/boards/{board_id}"),
    ("DELETE", "/api/workspaces/{slug}/boards/{board_id}"),
    ("POST", "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/fit/apply"),
    ("POST", "/api/workspaces/{slug}/skills"),
    ("POST", "/api/workspaces/{slug}/skills/{skill_slug}/archive"),
    ("POST", "/api/workspaces/{slug}/skills/{skill_slug}/unarchive"),
    ("POST", "/api/workspaces/{slug}/skills/{skill_slug}/versions"),
    ("POST", "/api/workspaces/{slug}/skills/{skill_slug}/versions/{version}/publish"),
    ("POST", "/api/workspaces/{slug}/skill-catalog/{catalog_id}/activate"),
    ("POST", "/api/workspaces/{slug}/loop-templates/import"),
    ("POST", "/api/workspaces/{slug}/loop-templates"),
    ("PATCH", "/api/workspaces/{slug}/loop-templates/{ref}"),
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/publish"),
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/duplicate"),
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/archive"),
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/unarchive"),
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/versions/{version}/restore"),
}

CREDENTIAL_MANAGEMENT_ROUTES = {
    ("GET", "/api/me/api-keys"),
    ("POST", "/api/me/api-keys"),
    ("DELETE", "/api/me/api-keys/{key_id}"),
    ("POST", "/api/agents"),
    ("POST", "/api/agents/{agent_id}/rotate-key"),
    ("POST", "/api/me/companion/installations"),
    ("GET", "/api/me/companion/installations"),
    ("GET", "/api/me/companion/installations/{installation_id}"),
    ("PATCH", "/api/me/companion/installations/{installation_id}"),
    ("POST", "/api/me/companion/installations/{installation_id}/rotate"),
    ("DELETE", "/api/me/companion/installations/{installation_id}"),
    ("DELETE", "/api/me/companion/installations/{installation_id}/sessions"),
    ("GET", "/api/me/companion/installations/{installation_id}/policy"),
    ("PATCH", "/api/me/companion/installations/{installation_id}/policy"),
    ("GET", "/api/me/companion/installations/{installation_id}/mappings"),
    ("POST", "/api/me/companion/installations/{installation_id}/mappings"),
    ("PATCH", "/api/me/companion/installations/{installation_id}/mappings/{mapping_id}"),
    ("DELETE", "/api/me/companion/installations/{installation_id}/mappings/{mapping_id}"),
    ("POST", "/api/me/companion/pairing/lookup"),
    ("POST", "/api/me/companion/pairing/approve"),
    ("POST", "/api/me/companion/pairing/deny"),
}

AGENT_ADMINISTRATION_REFUSAL = "Agent keys cannot perform agent administration"
CREDENTIAL_MANAGEMENT_REFUSAL = "Agent and companion keys cannot manage credentials"


def _routes_guarded_by(guard) -> set[tuple[str, str]]:
    return {
        (method, route.path)
        for route in create_app().routes
        if isinstance(route, APIRoute)
        and any(dependency.dependency is guard for dependency in route.dependencies)
        for method in route.methods
    }


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", lambda _: str(uuid.uuid4()), path)


async def _call(client: AsyncClient, method: str, path: str):
    body = {} if method in ("POST", "PATCH") else None
    return await client.request(method, _concrete(path), json=body)


def _refused_by(response, refusal: str) -> bool:
    return response.status_code == 403 and response.json().get("detail") == refusal


@pytest.fixture
async def agent_key_client(db_session, test_user):
    raw_key = "vlr_" + secrets.token_urlsafe(32)
    key = ApiKey(
        user_id=test_user.id,
        name="runner-key",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:8],
    )
    db_session.add(key)
    await db_session.flush()
    db_session.add(
        Agent(
            name="runner",
            agent_type=AgentType.coding,
            created_by_id=test_user.id,
            is_active=True,
            api_key_id=key.id,
        )
    )
    await db_session.flush()
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {raw_key}"},
    ) as client:
        yield client


def test_agent_administration_routes_are_exactly_the_listed_ones():
    assert _routes_guarded_by(forbid_agent_callers) == AGENT_ADMINISTRATION_ROUTES


def test_credential_management_routes_are_exactly_the_listed_ones():
    assert _routes_guarded_by(forbid_credential_management) == CREDENTIAL_MANAGEMENT_ROUTES


@pytest.mark.parametrize("method,path", sorted(AGENT_ADMINISTRATION_ROUTES))
async def test_agent_administration_installation_key_passes_guard(
    installation_key_client, test_workspace, method, path
):
    response = await _call(installation_key_client, method, path)
    assert not _refused_by(response, AGENT_ADMINISTRATION_REFUSAL), response.text


@pytest.mark.parametrize("method,path", sorted(AGENT_ADMINISTRATION_ROUTES))
async def test_agent_administration_agent_key_refused(
    agent_key_client, test_workspace, method, path
):
    response = await _call(agent_key_client, method, path)
    assert _refused_by(response, AGENT_ADMINISTRATION_REFUSAL), response.text


@pytest.mark.parametrize("method,path", sorted(CREDENTIAL_MANAGEMENT_ROUTES))
async def test_credential_management_installation_key_refused(
    installation_key_client, test_workspace, method, path
):
    response = await _call(installation_key_client, method, path)
    assert _refused_by(response, CREDENTIAL_MANAGEMENT_REFUSAL), response.text


@pytest.mark.parametrize("method,path", sorted(CREDENTIAL_MANAGEMENT_ROUTES))
async def test_credential_management_agent_key_refused(
    agent_key_client, test_workspace, method, path
):
    response = await _call(agent_key_client, method, path)
    assert _refused_by(response, CREDENTIAL_MANAGEMENT_REFUSAL), response.text


@pytest.mark.parametrize("method,path", sorted(CREDENTIAL_MANAGEMENT_ROUTES))
async def test_credential_management_plain_user_key_passes_guard(
    plain_key_client, test_workspace, method, path
):
    response = await _call(plain_key_client, method, path)
    assert not _refused_by(response, CREDENTIAL_MANAGEMENT_REFUSAL), response.text
