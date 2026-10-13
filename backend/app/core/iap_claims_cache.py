# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Keeps IAP JWT signature checks off the per-request hot path.

The rate limiter looks at the JWT of every caller that would otherwise land in
the IP tier — including callers that tier is already throttling — so anyone can
attach a token and make us pay a thread hop plus a signature check per request.
`iap_jwt_is_plausible` screens out what Google would never have issued without
any crypto, and verified claims are remembered until the token's own `exp`.
"""

import base64
import binascii
import hashlib
import json
import time
from collections import OrderedDict

IAP_ISSUER = "https://cloud.google.com/iap"
IAP_SIGNING_ALGORITHM = "ES256"
# Bounds memory against a flood of distinct valid tokens (one per signed-in
# user per ~10 min token lifetime is the normal load).
MAX_CACHED_TOKENS = 1024
# Real IAP assertions are ~1-1.5 KB. Anything far larger is refused before any
# decoding, so the screen's cost stays bounded per request.
MAX_TOKEN_LENGTH = 8192

_verified_claims: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()


def clear_verified_iap_claims_cache() -> None:
    _verified_claims.clear()


def token_digest(token: str, audience: str) -> str:
    """Scoped to the audience the claims were verified against, so changing
    IAP_AUDIENCE can never serve claims verified under the old one."""
    return hashlib.sha256(f"{audience}\0{token}".encode()).hexdigest()


def _segment_json(segment: str) -> object:
    padded = segment + "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def iap_jwt_is_plausible(token: str, audience: str) -> bool:
    """Could Google have issued this for us right now? Unsigned fields only:
    passing proves nothing, failing proves the signature check would fail."""
    if len(token) > MAX_TOKEN_LENGTH:
        return False
    segments = token.split(".")
    if len(segments) != 3:
        return False
    try:
        header, payload = _segment_json(segments[0]), _segment_json(segments[1])
    # Caller-controlled bytes: a nesting bomb raises RecursionError, not
    # ValueError, and this runs before the rate-limit bucket check.
    except (binascii.Error, ValueError, RecursionError):
        return False
    if not isinstance(header, dict) or not isinstance(payload, dict):
        return False
    kid, exp = header.get("kid"), payload.get("exp")
    return (
        header.get("alg") == IAP_SIGNING_ALGORITHM
        and isinstance(kid, str)
        and bool(kid)
        and isinstance(exp, int | float)
        and exp > time.time()
        and payload.get("aud") == audience
        and payload.get("iss") == IAP_ISSUER
    )


def cached_claims(token: str, audience: str) -> dict | None:
    digest = token_digest(token, audience)
    entry = _verified_claims.get(digest)
    if entry is None:
        return None
    expires_at, claims = entry
    if expires_at <= time.time():
        del _verified_claims[digest]
        return None
    _verified_claims.move_to_end(digest)
    return claims


def remember_claims(token: str, audience: str, claims: dict) -> None:
    """Claims without a future `exp` are never cached: nothing would bound them."""
    exp = claims.get("exp")
    if not isinstance(exp, int | float) or exp <= time.time():
        return
    digest = token_digest(token, audience)
    _verified_claims[digest] = (float(exp), claims)
    _verified_claims.move_to_end(digest)
    while len(_verified_claims) > MAX_CACHED_TOKENS:
        _verified_claims.popitem(last=False)
