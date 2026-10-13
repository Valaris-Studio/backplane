# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
import subprocess
from pathlib import Path

import pytest

from app.core.client_ip import EDGE_FORWARDED_FOR_HEADER, EDGE_SECRET_HEADER

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


def _location_block(config: str, location: str) -> str:
    return config.split(f"location {location} {{", 1)[1].split("\n    }", 1)[0]


@pytest.mark.parametrize("location", ["/api/", "/ws/"])
def test_proxy_sends_the_edge_chain_it_observed(location):
    block = _location_block((FRONTEND / "nginx.conf").read_text(), location)
    assert re.search(
        rf"proxy_set_header {EDGE_FORWARDED_FOR_HEADER} \$proxy_add_x_forwarded_for;",
        block,
    ), "the edge chain must end with the peer nginx itself saw"
    # Quoted so an unset secret renders as "" (header dropped), not a syntax error.
    assert f'proxy_set_header {EDGE_SECRET_HEADER} "${{EDGE_PROXY_SECRET}}";' in block


def test_startup_substitutes_the_edge_secret():
    script = (FRONTEND / "scripts/start-frontend.sh").read_text()
    envsubst = next(line for line in script.splitlines() if "envsubst" in line)
    assert "${EDGE_PROXY_SECRET}" in envsubst
    assert "${BACKEND_URL}" in envsubst


REFUSAL = "EDGE_PROXY_SECRET may only contain"


def _start_frontend(secret: str | None) -> subprocess.CompletedProcess:
    env = {"PATH": "/usr/bin:/bin"}
    if secret is not None:
        env["EDGE_PROXY_SECRET"] = secret
    # Outside the image the script dies at its first real step (no nginx
    # template to envsubst), so only the secret check is exercised.
    return subprocess.run(
        ["/bin/sh", str(FRONTEND / "scripts/start-frontend.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize(
    "secret", ['ab"cd', "ab$cd", "ab cd", "ab;cd", "ab\\cd", "ab'cd", "ünï"]
)
def test_startup_refuses_a_secret_nginx_would_misread(secret):
    result = _start_frontend(secret)
    assert result.returncode == 1
    assert REFUSAL in result.stderr
    assert "openssl rand -hex 32" in result.stderr
    assert secret not in result.stderr, "the secret must not be echoed into logs"


@pytest.mark.parametrize("secret", [None, "", "0123abcdef" * 6 + "abcd", "A-b_9"])
def test_startup_accepts_hex_and_token_safe_secrets(secret):
    assert REFUSAL not in _start_frontend(secret).stderr


@pytest.mark.parametrize(
    "doc",
    [
        ".env.example",
        # es/pt-BR render the en page's <code> nodes; the vitest locale parity
        # contract fails if a translation drops one.
        "frontend/src/pages/documentation/sections/reference-environment-variables.tsx",
    ],
)
def test_docs_tell_operators_to_generate_a_hex_secret(doc):
    text = (FRONTEND.parent / doc).read_text()
    section = text[text.index("Shared secret between the bundled frontend nginx") :]
    assert "openssl rand -hex 32" in section[:1500]
