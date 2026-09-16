# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard: the prod compose backend service must forward every setting.

`docker-compose.prod.yml`'s backend service uses an explicit `environment:`
allowlist (no `env_file`) and `.dockerignore` excludes `.env` from the build
context, so that allowlist is the ONLY channel a self-hoster's `.env` reaches
the container through. A `Settings` field missing from the block is silently
unconfigurable in prod; worse, an interpolation like `${VAR:-}` renders an
unset host var as an empty string, which pydantic treats as an explicit
override of a non-empty `Settings` default (`:-default` is the safe form —
"unset or empty" falls back). Same drift-guard pattern as
test_env_example_drift.py, one layer further down the pipe.
"""

import re
from pathlib import Path

import yaml
from pydantic import TypeAdapter

from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPO_ROOT / "docker-compose.prod.yml"
ENV_EXAMPLE = REPO_ROOT / ".env.example"

# Settings fields deliberately absent from the backend environment block:
# container-internal wiring the compose file itself decides, not something a
# self-hoster tunes. Every other Settings field must be forwarded (pinned,
# derived, or passthrough all count as "forwarded" — this allowlist just
# marks the one field for which "not present at all" is correct).
NOT_FORWARDED = {"PORT"}

# Assignments inside a commented block are documentation, not active config.
# Same regex as test_env_example_drift.py.
ASSIGNMENT = re.compile(r"^\s*(?P<commented>#\s*)?(?P<key>[A-Z][A-Z0-9_]*)=")

# .env.example keys consumed by docker-compose itself (prod stack or runner
# container), never read by backend `Settings` — mirrors NON_BACKEND_KEYS in
# test_env_example_drift.py.
NON_BACKEND_KEYS = {
    "POSTGRES_PASSWORD",
    "BACKPLANE_URL",
    "BACKPLANE_HTTP_PORT",
    "VALARIS_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
}

# .env.example keys that exist only to configure docker-compose (Postgres init
# args, image overrides, runner mount paths) — never forwarded to the backend
# container and not on Settings either.
NON_BACKEND_KEYS |= {
    "POSTGRES_USER",
    "POSTGRES_DB",
    "BACKPLANE_BACKEND_IMAGE",
    "BACKPLANE_FRONTEND_IMAGE",
    "BACKPLANE_RUNNER_IMAGE",
    "VALARIS_WORKSPACE",
    "BACKPLANE_RUNNER_CONFIG",
}

# A pure passthrough: `${KEY}` or `${KEY:-default}` where the interpolation
# variable is exactly the env key it's assigned to. `${KEY:?...}` (required,
# no fallback) is a different contract and is exempt from default-matching.
PASSTHROUGH = re.compile(r"^\$\{(?P<var>[A-Z][A-Z0-9_]*)(:-(?P<default>.*))?\}$")


def _backend_environment() -> dict[str, str]:
    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    return compose["services"]["backend"]["environment"]


def _parse_env_example_active() -> set[str]:
    active: set[str] = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        match = ASSIGNMENT.match(line)
        if match and not match.group("commented"):
            active.add(match.group("key"))
    return active


def test_every_setting_reaches_the_prod_backend():
    """Every `Settings` field must be reachable through the compose allowlist.

    A field absent here has no channel into the prod container at all — the
    backend's `.dockerignore` excludes `.env` from the build context, so this
    `environment:` block is the only path in.
    """
    env = _backend_environment()
    missing = set(Settings.model_fields) - set(env) - NOT_FORWARDED
    assert not missing, (
        f"Settings fields missing from docker-compose.prod.yml backend "
        f"environment: {sorted(missing)}. Add them as passthroughs (mirror "
        "the Settings default) or pin/derive them, or add to NOT_FORWARDED "
        "with a reason."
    )


def test_passthrough_defaults_match_settings():
    """A passthrough's compose default must equal the Settings default.

    `${VAR:-}` renders an unset host var as an empty string, and pydantic
    treats "" as an explicit override — not "unset" — for a non-empty
    Settings default. That mismatch is a silent auth-posture flip in prod
    (e.g. GIT_USER_NAME/GIT_USER_EMAIL currently pinned to `${VAR:-}` instead
    of mirroring their non-empty Settings defaults). `${VAR:?...}` (required)
    entries have no default to compare and are exempt.
    """
    env = _backend_environment()
    fields = Settings.model_fields
    mismatches: list[str] = []
    for key, value in env.items():
        if key not in fields or not isinstance(value, str):
            continue
        match = PASSTHROUGH.match(value)
        if not match or match.group("var") != key:
            continue
        compose_default_str = match.group("default") or ""
        field = fields[key]
        adapter = TypeAdapter(field.annotation)
        compose_default = adapter.validate_python(compose_default_str)
        if compose_default != field.default:
            mismatches.append(
                f"{key}: compose default {compose_default!r} != Settings default {field.default!r}"
            )
    assert not mismatches, (
        "Compose passthrough defaults drifted from Settings defaults:\n"
        + "\n".join(mismatches)
    )


def test_active_env_example_keys_are_forwarded():
    """Every active `.env.example` key must appear in the backend allowlist.

    A key a self-hoster is told to set that the compose file then drops on
    the floor is a documented setting that silently does nothing in prod.
    """
    env = _backend_environment()
    active = _parse_env_example_active()
    documented_backend_keys = active - NON_BACKEND_KEYS
    missing = documented_backend_keys - set(env) - NOT_FORWARDED
    assert not missing, (
        f".env.example documents keys not forwarded by the prod compose "
        f"backend environment block: {sorted(missing)}. Add them as "
        "passthroughs, or if compose-only/pinned/derived, add to "
        "NON_BACKEND_KEYS / NOT_FORWARDED with a reason."
    )
