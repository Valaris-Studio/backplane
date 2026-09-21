# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import secrets

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from app.core import auth
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.database import get_db
from app.exceptions import ForbiddenError
from app.services.api_key import ApiKeyService


def _actor_context():
    return {
        "agent_id": auth.current_agent_id.get(),
        "api_key_id": auth.current_api_key_id.get(),
        "api_key_name": auth.current_api_key_name.get(),
        "authentication_method": auth.current_authentication_method.get(),
    }


@pytest_asyncio.fixture
async def provenance_client(db_session, monkeypatch):
    monkeypatch.setattr(auth.settings, "ENV", "development")
    app = FastAPI()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database

    @app.get("/actor")
    async def actor(user=Depends(auth.get_current_user)):
        return {"user_id": user.id, **_actor_context()}

    @app.exception_handler(ForbiddenError)
    async def rejected_actor(_request, _error):
        return JSONResponse(_actor_context(), status_code=403)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


async def test_api_key_identity_does_not_leak_into_next_dev_request(
    provenance_client, db_session, test_user, test_agent
):
    key, raw_key = await ApiKeyService(db_session).create_key(test_user.id, "Runner key")
    test_agent.api_key_id = key.id
    await db_session.flush()

    response = await provenance_client.get(
        "/actor", headers={"Authorization": f"Bearer {raw_key}"}
    )
    assert response.status_code == 200
    assert response.json() == {
        "user_id": str(test_user.id),
        "agent_id": str(test_agent.id),
        "api_key_id": str(key.id),
        "api_key_name": key.name,
        "authentication_method": "api_key",
    }

    response = await provenance_client.get(
        "/actor", headers={"X-User-Email": test_user.email}
    )
    assert response.status_code == 200
    assert response.json() == {
        "user_id": str(test_user.id),
        "agent_id": None,
        "api_key_id": None,
        "api_key_name": None,
        "authentication_method": "dev",
    }


async def test_unlinked_user_key_is_api_key_authentication(
    provenance_client, db_session, test_user
):
    key, raw_key = await ApiKeyService(db_session).create_key(test_user.id, "Automation")

    response = await provenance_client.get(
        "/actor", headers={"Authorization": f"Bearer {raw_key}"}
    )

    assert response.status_code == 200
    assert response.json()["authentication_method"] == "api_key"
    assert response.json()["api_key_id"] == str(key.id)
    assert response.json()["agent_id"] is None
    assert raw_key not in response.text


@pytest.mark.parametrize("rejection", ["invalid_key", "deactivated_agent"])
async def test_rejected_credentials_leave_no_verified_actor_context(
    provenance_client, db_session, test_user, test_agent, rejection
):
    key, raw_key = await ApiKeyService(db_session).create_key(test_user.id, "Runner key")
    test_agent.api_key_id = key.id
    await db_session.flush()
    response = await provenance_client.get(
        "/actor", headers={"Authorization": f"Bearer {raw_key}"}
    )
    assert response.status_code == 200

    if rejection == "invalid_key":
        raw_key = "vlr_" + secrets.token_urlsafe(32)
    else:
        test_agent.is_active = False
        await db_session.flush()
    response = await provenance_client.get(
        "/actor", headers={"Authorization": f"Bearer {raw_key}"}
    )

    assert response.status_code == 403
    assert response.json() == {
        "agent_id": None,
        "api_key_id": None,
        "api_key_name": None,
        "authentication_method": None,
    }


async def test_signed_session_records_session_authentication(
    provenance_client, test_user, monkeypatch
):
    signing_key = secrets.token_urlsafe(32)
    monkeypatch.setattr(auth.settings, "ENV", "production")
    monkeypatch.setattr(auth.settings, "OAUTH_STATE_SIGNING_KEY", signing_key)
    provenance_client.cookies.set(
        SESSION_COOKIE_NAME, write_session(test_user.id, signing_key=signing_key)
    )

    response = await provenance_client.get("/actor")

    assert response.status_code == 200
    assert response.json()["authentication_method"] == "session"
    assert response.json()["api_key_id"] is None


async def test_verified_proxy_records_proxy_authentication(
    provenance_client, test_user, monkeypatch
):
    proxy_secret = secrets.token_urlsafe(32)
    monkeypatch.setattr(auth.settings, "ENV", "production")
    monkeypatch.setattr(auth.settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(auth.settings, "TRUSTED_PROXY_AUTH", True)
    monkeypatch.setattr(auth.settings, "TRUSTED_PROXY_SECRET", proxy_secret)
    monkeypatch.setattr(auth.settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "")

    response = await provenance_client.get(
        "/actor",
        headers={
            "X-Goog-Authenticated-User-Email": f"accounts.google.com:{test_user.email}",
            "X-Backplane-Proxy-Secret": proxy_secret,
        },
    )

    assert response.status_code == 200
    assert response.json()["authentication_method"] == "trusted_proxy"
    assert response.json()["api_key_id"] is None
    assert proxy_secret not in response.text


async def test_verified_iap_records_iap_authentication(
    provenance_client, test_user, monkeypatch
):
    async def verified_email(_request):
        return test_user.email

    monkeypatch.setattr(auth.settings, "ENV", "production")
    monkeypatch.setattr(auth.settings, "IAP_AUDIENCE", "test-audience")
    monkeypatch.setattr(auth.settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "")
    monkeypatch.setattr(auth, "_extract_email_from_iap_jwt", verified_email)

    response = await provenance_client.get("/actor")

    assert response.status_code == 200
    assert response.json()["authentication_method"] == "iap"
    assert response.json()["api_key_id"] is None
