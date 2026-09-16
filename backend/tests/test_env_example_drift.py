# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard: `.env.example` must describe the real `Settings` surface.

The example file is the first thing a self-hoster copies, so a key that no
longer exists (or a field that was never documented) sends them chasing a
setting that does nothing. Same pattern as the MCP catalog drift guard.
"""

import re
from pathlib import Path

from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_EXAMPLE = REPO_ROOT / ".env.example"

# Keys the example documents that are deliberately NOT backend settings: they
# are consumed by docker-compose (the prod stack or the runner container),
# not by `Settings`.
NON_BACKEND_KEYS = {
    "POSTGRES_PASSWORD",
    "BACKPLANE_URL",
    "BACKPLANE_HTTP_PORT",
    "VALARIS_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "BACKPLANE_BACKEND_IMAGE",
    "BACKPLANE_FRONTEND_IMAGE",
    "BACKPLANE_RUNNER_IMAGE",
    "VALARIS_WORKSPACE",
    "BACKPLANE_RUNNER_CONFIG",
}

# Assignments inside a commented block are documentation, not active config.
ASSIGNMENT = re.compile(r"^\s*(?P<commented>#\s*)?(?P<key>[A-Z][A-Z0-9_]*)=")


def _parse_env_example() -> tuple[set[str], set[str]]:
    """Return (active_keys, commented_keys) declared in .env.example."""
    active: set[str] = set()
    commented: set[str] = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        match = ASSIGNMENT.match(line)
        if not match:
            continue
        (commented if match.group("commented") else active).add(match.group("key"))
    return active, commented


def test_env_example_exists():
    assert ENV_EXAMPLE.is_file(), f"{ENV_EXAMPLE} is missing"


def test_every_documented_key_is_a_real_setting():
    """No key in .env.example may be absent from Settings.

    Catches the reverse of the usual drift: settings that were renamed or
    removed while the example kept advertising them.
    """
    active, commented = _parse_env_example()
    documented = (active | commented) - NON_BACKEND_KEYS
    unknown = documented - set(Settings.model_fields)
    assert not unknown, (
        f".env.example documents keys that do not exist on Settings: {sorted(unknown)}. "
        "Remove them, or add the field to backend/app/config.py."
    )


def test_every_setting_is_documented():
    """Every Settings field must appear in .env.example.

    A new setting that nobody documents is a setting self-hosters cannot find.
    """
    active, commented = _parse_env_example()
    undocumented = set(Settings.model_fields) - (active | commented)
    assert not undocumented, (
        f"Settings fields missing from .env.example: {sorted(undocumented)}. "
        "Document them so self-hosters can discover them."
    )


def test_settings_tolerates_compose_only_keys(tmp_path, monkeypatch):
    """`.env` is shared between docker compose and the backend.

    The compose-only keys (POSTGRES_PASSWORD, BACKPLANE_URL, ...) live in the
    same file, so Settings must ignore unknown keys — extra="forbid" would
    crash every backend process run with a self-hoster's .env on disk.
    """
    env = tmp_path / ".env"
    env.write_text(
        "POSTGRES_PASSWORD=example\nBACKPLANE_URL=\nBACKPLANE_HTTP_PORT=8080\n"
    )
    monkeypatch.chdir(tmp_path)
    assert Settings().ENV == "development"


def test_example_carries_no_real_credentials():
    """The example must never ship a usable secret or an internal hostname."""
    text = ENV_EXAMPLE.read_text()
    # A real platform key is `vlr_` + 40+ url-safe chars; placeholders are short.
    assert not re.search(
        r"vlr_[A-Za-z0-9_-]{40,}", text
    ), "real API key in .env.example"
    assert not re.search(
        r"sk-ant-[A-Za-z0-9_-]{20,}", text
    ), "real Anthropic key in .env.example"
    assert "a.run.app" not in text, "internal Cloud Run host in .env.example"
    assert (
        ".iam.gserviceaccount.com" not in text
    ), "internal service account in .env.example"
