# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration smoke runner — the cross-card seam gate.

Per-card pipelines catch unit bugs but miss seams (CORS, env vars,
migrations, MCP wiring, frontend build, auth round-trip). This script
exercises those seams locally and fails loudly on the first broken one.

Run via `make smoke` (full) or `make smoke-fast` (skips the frontend
build). `SMOKE_SKIP=name1,name2 make smoke` skips named checks.

Each check is a pure function returning a CheckResult. The driver
short-circuits on the first failure so the operator sees the actionable
error without scrolling through downstream noise.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
MCP_DIR = REPO_ROOT / "mcp-server"
CLOUDBUILD_PATH = REPO_ROOT / "cloudbuild.yaml"

GREEN = "\033[32m" if sys.stdout.isatty() else ""
RED = "\033[31m" if sys.stdout.isatty() else ""
RESET = "\033[0m" if sys.stdout.isatty() else ""


@dataclass
class CheckResult:
    name: str
    passed: bool
    details: str = ""

    def format_line(self) -> str:
        tag = f"{GREEN}[PASS]{RESET}" if self.passed else f"{RED}[FAIL]{RESET}"
        suffix = f" — {self.details}" if self.details else ""
        return f"{tag} {self.name}{suffix}"


# ---- check 1: migrations coherence ----------------------------------------

def _alembic_heads() -> list[str]:
    """Returns alembic head revisions (one entry per head). Two+ entries
    means a branch — autogen will silently produce diverging chains
    that bite on deploy.
    """
    proc = subprocess.run(
        ["alembic", "heads"],
        cwd=str(BACKEND_DIR),
        env={**os.environ, "DATABASE_URL": "sqlite+aiosqlite:////tmp/_smoke_dummy.db"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"alembic heads failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return [line for line in proc.stdout.strip().splitlines() if line.strip()]


def check_migrations() -> CheckResult:
    try:
        heads = _alembic_heads()
    except Exception as exc:
        return CheckResult("migrations", False, f"alembic invocation failed: {exc}")

    if len(heads) != 1:
        return CheckResult(
            "migrations",
            False,
            f"expected 1 alembic head, got {len(heads)}: {heads}",
        )
    return CheckResult("migrations", True, f"single head: {heads[0]}")


# ---- check 2: backend boots + healthz returns 200 -------------------------

async def _make_in_memory_engine_and_sm():
    """In-memory aiosqlite with StaticPool — every session shares the same
    underlying connection so cross-request writes are visible. Without
    StaticPool each new session gets a fresh empty :memory: DB.
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.pool import StaticPool

    from app.models.base import Base

    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, sm


async def _boot_and_health() -> tuple[bool, str]:
    """Boots the FastAPI app against in-memory sqlite, hits /api/health.
    Mirrors the in-process pattern that backend tests use, so this never
    needs Docker or a network port.
    """
    from httpx import ASGITransport, AsyncClient

    os.environ.setdefault("INTEGRATIONS_TOKEN_KEY", _ephemeral_fernet_key())
    os.environ.setdefault("OAUTH_STATE_SIGNING_KEY", "smoke-state-key")

    from app.database import get_db
    from app.main import create_app

    engine, sm = await _make_in_memory_engine_and_sm()
    app = create_app()

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://smoke") as client:
        resp = await client.get("/api/health")

    await engine.dispose()
    if resp.status_code != 200:
        return False, f"GET /api/health returned {resp.status_code}"
    payload = resp.json()
    if payload.get("status") != "ok":
        return False, f"unexpected payload: {payload}"
    return True, "200 OK"


def check_backend_boots() -> CheckResult:
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        ok, detail = asyncio.run(_boot_and_health())
    except Exception as exc:
        return CheckResult("backend-boots", False, f"boot raised: {exc}")
    return CheckResult("backend-boots", ok, detail)


# ---- check 3: CORS preflight ---------------------------------------------

async def _cors_preflight(origin: str) -> tuple[bool, str]:
    from httpx import ASGITransport, AsyncClient

    os.environ.setdefault("INTEGRATIONS_TOKEN_KEY", _ephemeral_fernet_key())
    os.environ.setdefault("OAUTH_STATE_SIGNING_KEY", "smoke-state-key")

    from app.main import create_app

    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://smoke") as client:
        resp = await client.options(
            "/api/workspaces",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    allow = resp.headers.get("access-control-allow-origin", "")
    if allow == origin:
        return True, f"Allow-Origin echoed for {origin}"
    return False, (
        f"Origin {origin} not allowed (Access-Control-Allow-Origin={allow!r}, "
        f"status={resp.status_code})"
    )


def check_cors(origin: str = "http://localhost:5173") -> CheckResult:
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        ok, detail = asyncio.run(_cors_preflight(origin))
    except Exception as exc:
        return CheckResult("cors", False, f"preflight raised: {exc}")
    return CheckResult("cors", ok, detail)


# ---- check 4: required env vars are declared on Settings ------------------

_ENV_VARS_LINE_RE = re.compile(r'--set-env-vars="\^\|\^([^"]+)"')
_SECRETS_LINE_RE = re.compile(r"--set-secrets=([^\s\\]+)")


def _cloudbuild_env_vars() -> set[str] | None:
    """Extracts the set of required env-var KEYS from cloudbuild.yaml's
    --set-env-vars and --set-secrets flags. Skips dynamic values like
    BACKEND_URL that are computed mid-build.

    None when the file is absent: the public export strips the private deploy
    pipeline, and self-hosters must still get a green smoke.
    """
    if not CLOUDBUILD_PATH.exists():
        return None
    text = CLOUDBUILD_PATH.read_text()
    keys: set[str] = set()

    for match in _ENV_VARS_LINE_RE.finditer(text):
        for pair in match.group(1).split("|"):
            if "=" in pair:
                keys.add(pair.split("=", 1)[0].strip())

    for match in _SECRETS_LINE_RE.finditer(text):
        for pair in match.group(1).split(","):
            if "=" in pair:
                keys.add(pair.split("=", 1)[0].strip())
    return keys


def check_required_env_vars() -> CheckResult:
    required = _cloudbuild_env_vars()
    if required is None:
        return CheckResult(
            "env-vars",
            True,
            "cloudbuild.yaml not present in this tree (internal-only check skipped)",
        )
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        from app.config import Settings
    except Exception as exc:
        return CheckResult("env-vars", False, f"could not import Settings: {exc}")

    declared = set(Settings.model_fields.keys())
    missing = sorted(required - declared)
    if missing:
        return CheckResult(
            "env-vars",
            False,
            f"required by cloudbuild but missing from app.config.Settings: {missing}",
        )
    return CheckResult("env-vars", True, f"{len(required)} vars declared")


# ---- check 5: MCP server module imports ----------------------------------

_MCP_PROBE_SCRIPT = (
    "import json; "
    "import valaris_mcp.server as s; "
    "mgr = getattr(s.mcp, '_tool_manager', None); "
    "tools = getattr(mgr, '_tools', None) or getattr(mgr, 'tools', {}) if mgr else {}; "
    "print(json.dumps({'tools': len(tools)}))"
)


def _import_module(name: str) -> dict:
    """Import the MCP server module via its own venv (it depends on
    `mcp[cli]` which isn't on the backend venv). Returns a dict with
    {'tools': N} on success; raises on import failure. Tests patch this
    to simulate import errors without spawning a subprocess.
    """
    mcp_python = MCP_DIR / ".venv" / "bin" / "python"
    if not mcp_python.exists():
        raise ImportError(
            f"mcp-server venv not found at {mcp_python}; run `make mcp-install` first"
        )

    proc = subprocess.run(
        [str(mcp_python), "-c", _MCP_PROBE_SCRIPT],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-5:]
        raise ImportError("\n".join(tail) or f"exit {proc.returncode}")

    import json as _json

    try:
        return _json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise ImportError(f"unexpected probe output: {proc.stdout!r}") from exc


def check_mcp_imports() -> CheckResult:
    """Boots the MCP server module and counts registered tools. Catches
    the recurring "MCP wiring drift" failure mode the audit flagged.
    """
    try:
        info = _import_module("valaris_mcp.server")
    except ImportError as exc:
        return CheckResult("mcp-imports", False, str(exc))
    except Exception as exc:
        return CheckResult("mcp-imports", False, f"import failed: {exc}")

    tool_count = info.get("tools", 0) if isinstance(info, dict) else 0
    return CheckResult("mcp-imports", True, f"loaded; {tool_count} tools registered")


# ---- check 6: frontend builds (TS gate) ----------------------------------

def check_frontend_build() -> CheckResult:
    if not (FRONTEND_DIR / "package.json").exists():
        return CheckResult("frontend-build", False, "frontend/package.json not found")
    if shutil.which("pnpm") is None:
        return CheckResult("frontend-build", False, "pnpm not found on PATH")

    proc = subprocess.run(
        ["pnpm", "build"],
        cwd=str(FRONTEND_DIR),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        # Last 30 lines is enough signal to identify the broken file.
        tail = "\n".join(proc.stderr.strip().splitlines()[-30:])
        return CheckResult("frontend-build", False, f"pnpm build failed:\n{tail}")
    return CheckResult("frontend-build", True, "pnpm build OK")


# ---- check 7: round-trip API (auth header → workspace tenancy seam) -------

async def _round_trip() -> tuple[bool, str]:
    from httpx import ASGITransport, AsyncClient

    os.environ.setdefault("INTEGRATIONS_TOKEN_KEY", _ephemeral_fernet_key())
    os.environ.setdefault("OAUTH_STATE_SIGNING_KEY", "smoke-state-key")

    from app.database import get_db
    from app.main import create_app

    engine, sm = await _make_in_memory_engine_and_sm()
    app = create_app()

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    headers = {"X-User-Email": "smoke@valaris.dev"}
    slug = f"smoke-{int(time.time() * 1000)}"

    try:
        async with AsyncClient(transport=transport, base_url="http://smoke") as client:
            create = await client.post(
                "/api/workspaces",
                json={"name": "Smoke", "slug": slug},
                headers=headers,
            )
            if create.status_code != 201:
                return False, f"POST /api/workspaces returned {create.status_code}: {create.text[:200]}"

            get = await client.get(f"/api/workspaces/{slug}", headers=headers)
            if get.status_code != 200:
                return False, f"GET /api/workspaces/{slug} returned {get.status_code}: {get.text[:200]}"
            if get.json().get("slug") != slug:
                return False, f"slug round-trip mismatch: {get.json()}"
    finally:
        await engine.dispose()
    return True, f"created+read workspace slug={slug}"


def check_round_trip_api() -> CheckResult:
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        ok, detail = asyncio.run(_round_trip())
    except Exception as exc:
        return CheckResult("round-trip", False, f"round-trip raised: {exc}")
    return CheckResult("round-trip", ok, detail)


# ---- helpers --------------------------------------------------------------

def _ephemeral_fernet_key() -> str:
    """Generate a one-shot Fernet key so FernetTokenVault doesn't refuse
    to initialize during smoke. Real prod uses a secret-managed key.
    """
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode()


# ---- driver ---------------------------------------------------------------

CheckFn = Callable[[], CheckResult]


def _default_checks(skip_frontend: bool) -> list[tuple[str, CheckFn]]:
    checks: list[tuple[str, CheckFn]] = [
        ("migrations", check_migrations),
        ("env-vars", check_required_env_vars),
        ("mcp-imports", check_mcp_imports),
        ("backend-boots", check_backend_boots),
        ("cors", lambda: check_cors("http://localhost:5173")),
        ("round-trip", check_round_trip_api),
    ]
    if not skip_frontend:
        checks.append(("frontend-build", check_frontend_build))
    return checks


def run_checks(checks: Iterable[tuple[str, CheckFn]]) -> int:
    skip = {s.strip() for s in os.environ.get("SMOKE_SKIP", "").split(",") if s.strip()}
    failed = False
    for name, fn in checks:
        if name in skip:
            print(f"[SKIP] {name}")
            continue
        start = time.monotonic()
        try:
            result = fn()
        except Exception as exc:  # defensive: a check should never raise
            result = CheckResult(name=name, passed=False, details=f"unhandled exception: {exc}")
        elapsed_ms = int((time.monotonic() - start) * 1000)
        print(f"{result.format_line()}  ({elapsed_ms} ms)")
        if not result.passed:
            failed = True
            return 1
    return 1 if failed else 0


def main(skip_frontend: bool = False) -> int:
    print(f"valaris smoke — repo={REPO_ROOT}")
    return run_checks(_default_checks(skip_frontend=skip_frontend))


if __name__ == "__main__":
    skip_frontend = "--fast" in sys.argv or os.environ.get("SMOKE_FAST") == "1"
    sys.exit(main(skip_frontend=skip_frontend))
