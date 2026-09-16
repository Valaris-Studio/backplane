# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard: native (non-Docker) dev paths must agree with docker-compose.

`docker-compose.yml` publishes Postgres on a host port that is NOT 5432 (port
collision avoidance with a host-installed Postgres), so anything a native
contributor runs outside the compose network — `Settings` defaults,
`.env.example`, `alembic.ini`, the Makefile's `DB_URL` — must point at the
*published* port, not the container-internal one. These files drifted apart
silently because Docker users never notice: the container talks to
`postgres:5432` on the compose network regardless of what the host port is.
Native dev is the first thing a contributor without Docker hits, so a wrong
default here is a "can't connect to Postgres" wall on their very first
command. Same drift-guard family as test_env_example_drift.py and
test_prod_compose_env_drift.py, one layer further into the native path.

This file also guards the `make mcp-install` recipe: a `cmd1 && cmd2 || cmd3`
chain where `cmd3` starts with `cd mcp-server` re-runs that `cd` from wherever
`cmd1`/`cmd2` already left the shell, which is inside `mcp-server` on the
success path that `2>/dev/null` masks failures for — the fallback silently
becomes a no-op `cd` into a nonexistent nested directory, and no `.venv` is
ever created for `scripts/smoke.py` to find.
"""

import re
from pathlib import Path

import yaml

from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"
ENV_EXAMPLE = REPO_ROOT / ".env.example"
ALEMBIC_INI = REPO_ROOT / "backend" / "alembic.ini"
MAKEFILE = REPO_ROOT / "Makefile"

# Host side is either a literal port or the quickstart-gate's ${VAR:-default}
# override; the drift contract is about the DEFAULT a plain `docker compose up`
# binds, so the ${...:-N} form resolves to N.
PORT_MAPPING = re.compile(
    r"^(?:\$\{[A-Z_]+:-(?P<host_default>\d+)\}|(?P<host>\d+)):(?P<container>\d+)$"
)
DATABASE_URL_LINE = re.compile(r"^DATABASE_URL=(?P<url>.+)$")
DB_URL_LINE = re.compile(r"^DB_URL\s*\?=\s*(?P<url>.+)$")
URL_PORT = re.compile(r":(?P<port>\d+)/")


def _compose_postgres_host_port() -> int:
    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    for mapping in compose["services"]["postgres"]["ports"]:
        match = PORT_MAPPING.match(str(mapping))
        if match and match.group("container") == "5432":
            return int(match.group("host") or match.group("host_default"))
    raise AssertionError(f"no host mapping for container port 5432 in {mapping!r}")


def _port_from_url(url: str) -> int:
    match = URL_PORT.search(url)
    assert match, f"no :port/ found in {url!r}"
    return int(match.group("port"))


def _mcp_install_recipe_lines() -> list[str]:
    lines = MAKEFILE.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line == "mcp-install:")
    recipe = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        recipe.append(line)
    return recipe


def test_settings_default_db_port_matches_compose():
    """Settings.DATABASE_URL default must target the compose-published port.

    A native `uvicorn app.main:app` with no DATABASE_URL override reads this
    default straight into asyncpg — pointed at 5432 it connects to whatever a
    contributor's own host Postgres has bound there (or nothing), never the
    compose Postgres this project actually ships.
    """
    compose_port = _compose_postgres_host_port()
    default_url = Settings.model_fields["DATABASE_URL"].default
    assert _port_from_url(default_url) == compose_port, (
        f"Settings.DATABASE_URL default uses port {_port_from_url(default_url)} "
        f"but docker-compose.yml publishes Postgres on {compose_port}: {default_url!r}"
    )


def test_env_example_database_url_matches_settings_default():
    """.env.example's DATABASE_URL must equal the Settings default exactly.

    Same contract as test_env_example_drift.py: the example is what a
    contributor copies verbatim, so it must never say something the code
    doesn't.
    """
    default_url = Settings.model_fields["DATABASE_URL"].default
    for line in ENV_EXAMPLE.read_text().splitlines():
        match = DATABASE_URL_LINE.match(line)
        if match:
            assert match.group("url") == default_url, (
                f".env.example DATABASE_URL={match.group('url')!r} != "
                f"Settings default {default_url!r}"
            )
            return
    raise AssertionError("no active DATABASE_URL= line found in .env.example")


def test_makefile_db_url_port_matches_compose():
    """The Makefile's migrate/seed-demo-native DB_URL must use the published port."""
    compose_port = _compose_postgres_host_port()
    for line in MAKEFILE.read_text().splitlines():
        match = DB_URL_LINE.match(line)
        if match:
            assert _port_from_url(match.group("url")) == compose_port, (
                f"Makefile DB_URL uses port {_port_from_url(match.group('url'))} "
                f"but docker-compose.yml publishes {compose_port}: {match.group('url')!r}"
            )
            return
    raise AssertionError("no DB_URL ?= line found in Makefile")


def test_alembic_ini_port_matches_compose():
    """alembic.ini's sqlalchemy.url must use the compose-published port.

    env.py overrides this at runtime from Settings, but a contributor running
    bare `alembic upgrade head` with no override (or just reading the file to
    understand what it does) hits this literal value.
    """
    compose_port = _compose_postgres_host_port()
    for line in ALEMBIC_INI.read_text().splitlines():
        if line.strip().startswith("sqlalchemy.url"):
            url = line.split("=", 1)[1].strip()
            assert _port_from_url(url) == compose_port, (
                f"alembic.ini sqlalchemy.url uses port {_port_from_url(url)} "
                f"but docker-compose.yml publishes {compose_port}: {url!r}"
            )
            return
    raise AssertionError("no sqlalchemy.url line found in alembic.ini")


def test_mcp_install_recipe_creates_venv_safely():
    """`make mcp-install` must create its own venv, not silently no-op on fallback.

    The bug class: a `cmd && cmd || fallback` chain whose fallback opens with
    `cd mcp-server` assumes it's starting from the repo root, but on the
    success-masking `2>/dev/null` path the shell is already inside
    `mcp-server` from the first `cd` in the same chain — the fallback `cd`
    then fails silently (or lands somewhere unintended) and never creates the
    `.venv` that `scripts/smoke.py` requires.
    """
    recipe = _mcp_install_recipe_lines()
    joined = "\n".join(recipe)

    assert "|| cd " not in joined, (
        "mcp-install recipe has a pipe-fallback starting with `cd` — this "
        "re-cd's from wherever the prior command in the chain already left "
        f"the shell, not from the repo root. Recipe:\n{joined}"
    )
    assert re.search(r"\buv venv\b", joined) or re.search(r"-m\s+venv\b", joined), (
        f"mcp-install recipe never creates a .venv (no `uv venv` / `-m venv`). "
        f"Recipe:\n{joined}"
    )
    assert (
        "[dev]" in joined
    ), f"mcp-install recipe doesn't install the dev extra. Recipe:\n{joined}"


def test_mcp_install_fallback_survives_stock_python():
    """The no-uv fallback must not trust a bare `python3` blindly.

    Live-verified failure mode (adversarial verification, 2026-08-01): on a
    macOS with only Apple's stock python3 (3.9, bundled pip 21) the fallback
    created a useless venv whose pip predates PEP 660 and dies with a
    misleading "setup.py not found" — the package's requires-python is
    >=3.12. The recipe must therefore (a) prefer versioned interpreters
    before bare `python3`, and (b) upgrade pip inside the fresh venv before
    the editable install, which both unblocks 3.12 venvs with stale bundled
    pip and turns the stock-3.9 dead end into the legible requires-python
    error.
    """
    joined = "\n".join(_mcp_install_recipe_lines())

    assert re.search(r"python3\.\d+\s+-m\s+venv", joined), (
        "mcp-install fallback must try a versioned interpreter (python3.1x) "
        f"before bare python3. Recipe:\n{joined}"
    )
    assert re.search(
        r"-m\s+pip\s+install\s+(--quiet\s+)?(-U|--upgrade)\s+pip", joined
    ), (
        "mcp-install fallback must upgrade pip inside the venv before the "
        f"editable install (bundled pip on older interpreters predates PEP 660). "
        f"Recipe:\n{joined}"
    )
