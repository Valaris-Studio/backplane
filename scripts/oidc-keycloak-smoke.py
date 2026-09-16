# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Manual smoke: drive the real OIDC code against a live Keycloak container.

Deliberately NOT in CI — CI uses the fixture IdP in tests/core/test_oidc.py.
This covers what a fixture cannot: real discovery, real RS256 JWKS, a real
authorization-code + PKCE exchange, and real ID-token claims.

Setup (about a minute):

    docker run -d --name backplane-kc-smoke -p 8899:8080 \\
      -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \\
      quay.io/keycloak/keycloak:26.0 start-dev

    kc() { docker exec backplane-kc-smoke /opt/keycloak/bin/kcadm.sh "$@"; }
    kc config credentials --server http://localhost:8080 --realm master \\
      --user admin --password admin
    kc create realms -s realm=backplane -s enabled=true
    kc create clients -r backplane -s clientId=backplane -s enabled=true \\
      -s publicClient=false -s secret=smoke-secret -s standardFlowEnabled=true \\
      -s 'redirectUris=["http://localhost:8000/api/auth/oidc/callback"]'
    kc create users -r backplane -s username=alice -s email=alice@corp.example \\
      -s emailVerified=true -s enabled=true -s firstName=Alice -s lastName=Smith
    kc set-password -r backplane --username alice --new-password hunter2

Run:  cd backend && PYTHONPATH=. .venv/bin/python ../scripts/oidc-keycloak-smoke.py
Teardown:  docker rm -f backplane-kc-smoke

A user missing firstName/lastName trips Keycloak's VERIFY_PROFILE required
action and the flow stops before issuing a code — set both, as above.
"""

import asyncio
import re
from urllib.parse import parse_qs, urlsplit

import httpx

ISSUER = "http://localhost:8899/realms/backplane"
CLIENT_ID = "backplane"
CLIENT_SECRET = "smoke-secret"
REDIRECT_URI = "http://localhost:8000/api/auth/oidc/callback"
USERNAME, PASSWORD = "alice", "hunter2"


async def main() -> int:
    from app.config import settings
    from app.core.oidc import OidcClient
    from app.services.auth.oidc_auth import new_pkce_verifier, pkce_challenge

    settings.OIDC_ISSUER = ISSUER
    settings.OIDC_CLIENT_ID = CLIENT_ID
    settings.OIDC_CLIENT_SECRET = CLIENT_SECRET
    settings.OIDC_SCOPES = "openid email profile"

    client = OidcClient(issuer=ISSUER, client_id=CLIENT_ID, client_secret=CLIENT_SECRET)

    # 1. discovery against the real IdP
    discovery = await client.discovery()
    print(f"✓ discovery      : {discovery.issuer}")
    print(f"  authorization  : {discovery.authorization_endpoint}")
    print(f"  end_session    : {discovery.end_session_endpoint}")
    assert discovery.end_session_endpoint, "Keycloak advertises RP-initiated logout"

    # 2. login leg — the URL our service would send the browser to
    verifier = new_pkce_verifier()
    nonce = "smoke-nonce-12345"
    state = "smoke-state-67890"
    auth_url = (
        f"{discovery.authorization_endpoint}"
        f"?response_type=code&client_id={CLIENT_ID}"
        f"&redirect_uri={REDIRECT_URI}&scope=openid+email+profile"
        f"&state={state}&nonce={nonce}"
        f"&code_challenge={pkce_challenge(verifier)}&code_challenge_method=S256"
    )

    # 3. act as the browser: submit Keycloak's login form to obtain a code
    async with httpx.AsyncClient(follow_redirects=False, timeout=20) as browser:
        page = await browser.get(auth_url)
        assert page.status_code == 200, f"login page: {page.status_code}"
        form_action = re.search(r'action="([^"]+)"', page.text)
        assert form_action, "could not find Keycloak login form"
        action = form_action.group(1).replace("&amp;", "&")

        # Keycloak marks AUTH_SESSION_ID/KC_RESTART `Secure`, so an http:// test
        # client will not replay them on its own ("Cookie not found"). A real
        # deployment is https and unaffected — re-send them by hand here.
        cookie_header = "; ".join(
            f"{name}={value}" for name, value in page.cookies.items()
        )
        posted = await browser.post(
            action,
            data={"username": USERNAME, "password": PASSWORD, "credentialId": ""},
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "cookie": cookie_header,
            },
        )
        location = posted.headers.get("location", "")
        if not location:
            snippet = re.sub(r"\s+", " ", posted.text)[:300]
            raise AssertionError(
                f"no redirect (status {posted.status_code}): {snippet}"
            )
        assert location.startswith(
            REDIRECT_URI
        ), f"unexpected redirect: {location[:120]}"
        params = parse_qs(urlsplit(location).query)
        assert params.get("state", [""])[0] == state, "state did not round-trip"
        code = params["code"][0]
        print("✓ authorization  : code received, state round-tripped")

    # 4. our own exchange + verification path
    id_token = await client.exchange_code(
        code=code, code_verifier=verifier, redirect_uri=REDIRECT_URI
    )
    print(f"✓ token exchange : id_token {len(id_token)} chars")

    claims = await client.verify_id_token(id_token, nonce=nonce)
    print(f"✓ verification   : email={claims['email']} sub={claims['sub'][:8]}…")
    assert claims["email"] == "alice@corp.example"

    # 5. negative: a wrong nonce must be refused (replay defense, live keys)
    from app.core.oidc import OidcError

    try:
        await client.verify_id_token(id_token, nonce="not-the-nonce")
        print("✗ nonce mismatch was ACCEPTED — bug")
        return 1
    except OidcError:
        print("✓ replay defense : wrong nonce rejected")

    # 6. negative: a tampered signature must be refused against real JWKS
    try:
        await client.verify_id_token(id_token[:-6] + "AAAAAA", nonce=nonce)
        print("✗ tampered token was ACCEPTED — bug")
        return 1
    except OidcError:
        print("✓ signature      : tampered token rejected against live JWKS")

    print("\nALL LIVE KEYCLOAK CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
