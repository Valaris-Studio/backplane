#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""End-to-end run of the real companion, backend and MCP server.

Synthetic input only: hook payloads and Codex-shaped OTLP are generated here;
no agent, model or real agent configuration is involved. Everything runs in a
disposable Postgres database, a throwaway work root (outside the temp
directories the companion deliberately never captures) and a dev-only file
credential store, and is torn down at the end.

Run with the MCP server's interpreter (it provides httpx and the MCP SDK):

    mcp-server/.venv/bin/python scripts/e2e/companion_e2e.py \\
        --pg-root /path/to/disposable-cluster \\
        --beacon-artifact /path/to/artifact.json \\
        --otelcol-artifact /path/to/otelcol.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import Implementation

REPO = Path(__file__).resolve().parents[2]
PG_PORT = 52035
DATABASE = "e2e"
OWNER = "owner@e2e.test"
OTHER = "other@e2e.test"
REPO_URL = "https://github.com/e2e-org/e2e-repo.git"
# Mixed case on purpose: auto-match must normalize before comparing.
ORIGIN = "git@github.com:E2E-Org/e2e-repo.git"
UNMAPPED_ORIGIN = "git@github.com:someone-else/private-repo.git"
E2E_BRANCH = "e2e/branch-1"
# Spellings of a home directory that must never reach the server.
LOCAL_PATH_MARKERS = ("/Users/", "/home/", "C:\\Users", "C:\\\\Users")
POLL_SECONDS = 60


class Failure(Exception):
    def __init__(self, message: str, evidence: Any = None):
        super().__init__(message)
        self.evidence = evidence


def check(condition: bool, message: str, evidence: Any = None) -> None:
    if not condition:
        raise Failure(message, evidence)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def trim(value: Any, limit: int = 600) -> Any:
    text = json.dumps(value, default=str)
    return value if len(text) <= limit else text[:limit] + "…"


def wait_for(description: str, probe: Callable[[], Any], timeout: float = POLL_SECONDS) -> Any:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = probe()
        if last:
            return last
        time.sleep(0.5)
    raise Failure(f"timed out waiting for {description}", last)


class Postgres:
    def __init__(self, root: Path):
        self.root = root
        self.bin = root / "install" / "bin"
        self.data = root / "data"
        self.started = False

    def _run(self, *args: str, check_exit: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(args, capture_output=True, encoding="utf-8", errors="replace", check=check_exit)

    def start(self) -> None:
        status = self._run(str(self.bin / "pg_ctl"), "-D", str(self.data), "status", check_exit=False)
        if status.returncode != 0:
            self._run(str(self.bin / "pg_ctl"), "-D", str(self.data), "-l", str(self.root / "e2e-server.log"),
                      "-o", f"-h 127.0.0.1 -p {PG_PORT} -k {self.root}", "-w", "start")
            self.started = True

    def recreate(self) -> None:
        self._run(str(self.bin / "dropdb"), "-h", "127.0.0.1", "-p", str(PG_PORT), "--if-exists", "--force", DATABASE)
        self._run(str(self.bin / "createdb"), "-h", "127.0.0.1", "-p", str(PG_PORT), DATABASE)

    def query(self, sql: str) -> list[list[str]]:
        result = self._run(str(self.bin / "psql"), "-h", "127.0.0.1", "-p", str(PG_PORT), "-d", DATABASE, "-At", "-F", "\t", "-c", sql)
        return [line.split("\t") for line in result.stdout.splitlines() if line]

    def dump(self) -> str:
        """Every row of every table, to prove what is (not) stored anywhere."""
        return self._run(str(self.bin / "pg_dump"), "-h", "127.0.0.1", "-p", str(PG_PORT), "--data-only", DATABASE).stdout

    def drop_and_stop(self) -> None:
        self._run(str(self.bin / "dropdb"), "-h", "127.0.0.1", "-p", str(PG_PORT), "--if-exists", "--force", DATABASE, check_exit=False)
        if self.started:
            self._run(str(self.bin / "pg_ctl"), "-D", str(self.data), "-w", "stop", check_exit=False)

    @property
    def url(self) -> str:
        return f"postgresql+asyncpg://{os.environ.get('USER', 'postgres')}@127.0.0.1:{PG_PORT}/{DATABASE}"


class Backend:
    def __init__(self, python: str, database_url: str, work: Path):
        self.python = python
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        # The approval page must share the pairing endpoint's origin (contract v1.9), and the companion accepts plain
        # HTTP only on a literal loopback IP, never localhost. Pairing is approved via the API; the page is never loaded.
        self.env = {**os.environ, "DATABASE_URL": database_url, "ENV": "development",
                    "LOCAL_STORAGE_DIR": str(work / "resources"), "FRONTEND_URL": self.url}
        self.log = work / "backend.log"
        self.process: subprocess.Popen | None = None

    def migrate(self) -> None:
        subprocess.run([self.python, "-m", "alembic", "upgrade", "head"], cwd=REPO / "backend", env=self.env,
                       check=True, capture_output=True, encoding="utf-8", errors="replace", timeout=600)

    def start(self) -> None:
        with open(self.log, "a", encoding="utf-8") as log:
            self.process = subprocess.Popen(
                [self.python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(self.port)],
                cwd=REPO / "backend", env=self.env, stdout=log, stderr=subprocess.STDOUT)
        wait_for("backend health", lambda: self._healthy(), timeout=60)

    def _healthy(self) -> bool:
        try:
            return httpx.get(self.url + "/api/health", timeout=2).status_code == 200
        except httpx.HTTPError:
            return False

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None


class Api:
    def __init__(self, url: str):
        self.client = httpx.Client(base_url=url, timeout=30)

    def call(self, method: str, path: str, email: str = OWNER, expect: tuple[int, ...] = (200, 201), **kwargs: Any) -> Any:
        response = self.client.request(method, path, headers={"X-User-Email": email}, **kwargs)
        check(response.status_code in expect, f"{method} {path} returned {response.status_code}", response.text[:500])
        return response.json() if response.content else None


class Companion:
    """The built companion with every home, config dir and credential isolated."""

    def __init__(self, binary: Path, work: Path, beacon: str, otelcol: str, data: Path | None = None):
        self.binary = str(binary)
        self.home = work / "home"
        self.data = data or work / "companion-data"
        for directory in (self.home, self.home / ".claude", self.home / ".codex", self.home / ".pi" / "agent"):
            directory.mkdir(parents=True, exist_ok=True)
        self.env = {
            "HOME": str(self.home), "PATH": os.environ["PATH"], "LANG": "en_US.UTF-8",
            "BACKPLANE_COMPANION_HOME": str(self.data),
            "BACKPLANE_COMPANION_KEYRING": "file-insecure-dev",
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
            "CODEX_HOME": str(self.home / ".codex"),
            "PI_CODING_AGENT_DIR": str(self.home / ".pi" / "agent"),
            "BACKPLANE_BEACON_ARTIFACT": beacon,
            "BACKPLANE_OTELCOL_ARTIFACT": otelcol,
        }
        self.log = work / "companion.log"
        self.daemon: subprocess.Popen | None = None

    def run(self, *args: str, stdin: str = "", extra: dict | None = None, expect_ok: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run([self.binary, *args], input=stdin, capture_output=True, encoding="utf-8", errors="replace",
                                env={**self.env, **(extra or {})}, timeout=120)
        if expect_ok:
            check(result.returncode == 0, f"companion {' '.join(args)} failed", result.stderr.strip()[-800:])
        return result

    def json(self, *args: str, **kwargs: Any) -> Any:
        return json.loads(self.run(*args, **kwargs).stdout)

    def hook(self, agent: str, payload: dict) -> None:
        result = self.run("hook", agent, stdin=json.dumps(payload))
        check(result.stdout.strip() == "{}", f"hook {agent} did not answer {{}}", result.stdout)

    def start_daemon(self) -> None:
        self.daemon = subprocess.Popen([self.binary, "run", "--log", str(self.log)], env=self.env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for("daemon start", lambda: self.status().get("daemon_running"), timeout=30)

    def stop_daemon(self) -> None:
        if self.daemon and self.daemon.poll() is None:
            self.daemon.send_signal(signal.SIGTERM)
            try:
                self.daemon.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.daemon.kill()
        self.daemon = None

    def status(self) -> dict:
        return self.json("status")

    def gate(self) -> str:
        settings = json.loads((self.data / "otel.json").read_text(encoding="utf-8"))
        return f"http://127.0.0.1:{settings['gate_port']}"


class ControlClient:
    """The daemon's local control API over its Unix socket, as the desktop app reaches it."""

    def __init__(self, data: Path):
        self.client = httpx.Client(transport=httpx.HTTPTransport(uds=str(data / "control.sock")),
                                   base_url="http://companion", timeout=30)

    def call(self, method: str, path: str, **kwargs: Any) -> tuple[int, Any]:
        response = self.client.request(method, path, **kwargs)
        return response.status_code, response.json() if response.content else None


class McpClient:
    """A real MCP stdio session with the worktree's MCP server."""

    def __init__(self, python: str, backend_url: str, api_key: str):
        self.params = StdioServerParameters(
                        # The console-script entry point: `-m valaris_mcp.server` would run the
            # module as __main__ and register tools on a second instance.
            command=python, args=["-c", "from valaris_mcp.server import main; main()"], cwd=str(REPO / "mcp-server"),
            env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "PYTHONPATH": str(REPO / "mcp-server" / "src"),
                 "VALARIS_API_URL": backend_url, "VALARIS_API_KEY": api_key})

    async def _call(self, client_name: str, tool: str, arguments: dict, meta: dict) -> Any:
        async with stdio_client(self.params) as (read, write):
            async with ClientSession(read, write, client_info=Implementation(name=client_name, version="e2e")) as session:
                await session.initialize()
                result = await session.call_tool(tool, arguments, meta=meta)
                check(not result.isError, f"MCP {tool} failed", [c.model_dump() for c in result.content])
                return [c.model_dump() for c in result.content]

    def call(self, client_name: str, tool: str, arguments: dict, meta: dict) -> Any:
        return asyncio.run(self._call(client_name, tool, arguments, meta))


def git_repo(path: Path, origin: str) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    for command in (["git", "init", "-q", "-b", E2E_BRANCH], ["git", "remote", "add", "origin", origin]):
        subprocess.run(command, cwd=path, check=True, capture_output=True)
    return path.resolve()


class Run:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.work = Path(tempfile.mkdtemp(prefix="backplane-e2e-", dir=args.work_root))
        self.postgres = Postgres(Path(args.pg_root))
        self.backend = Backend(args.backend_python, self.postgres.url, self.work)
        self.api = Api(self.backend.url)
        binary = self.work / "bin" / "backplane-companion"
        subprocess.run(["go", "build", "-tags", "devkeyring", "-o", str(binary), "./cmd/backplane-companion"],
                       cwd=REPO / "companion", check=True)
        self.companion = Companion(binary, self.work, args.beacon_artifact, args.otelcol_artifact)
        self.results: list[tuple[str, str, Any]] = []
        self.seed: dict[str, Any] = {}
        self.paired: Companion | None = None

    # --- helpers ---------------------------------------------------------

    def sessions(self, harness: str | None = None, email: str = OWNER) -> list[dict]:
        page = self.api.call("GET", f"/api/workspaces/{self.seed['slug']}/sessions", email=email, params={"limit": 100})
        return [item for item in page["items"] if harness is None or item["harness"] == harness]

    def session(self, native_id: str) -> dict | None:
        return next((item for item in self.sessions() if item["native_session_id"] == native_id), None)

    def events(self, session_id: str) -> list[dict]:
        return self.api.call("GET", f"/api/workspaces/{self.seed['slug']}/sessions/{session_id}/events", params={"limit": 200})["items"]

    def links(self, session_id: str) -> list[dict]:
        return self.api.call("GET", f"/api/workspaces/{self.seed['slug']}/sessions/{session_id}/links")["items"]

    def card_sessions(self, email: str = OWNER, expect: tuple[int, ...] = (200,)) -> Any:
        return self.api.call("GET", f"/api/workspaces/{self.seed['slug']}/boards/{self.seed['board_id']}/cards/{self.seed['card_id']}/sessions",
                             email=email, expect=expect)

    def capture_window_open(self, mapping_id: str) -> bool:
        path = self.companion.data / "capture-windows.json"
        if not path.exists():
            return False
        windows = json.loads(path.read_text(encoding="utf-8")).get("windows") or {}
        return any(key.endswith("\x00" + mapping_id) and spans and spans[-1].get("open") for key, spans in windows.items())

    def mappings(self) -> list[dict]:
        return self.api.call("GET", f"/api/me/companion/installations/{self.seed['installation_id']}/mappings")

    def claude_session(self, session_id: str, cwd: Path, prompt: str, command: str, output: str, tool_use_id: str,
                       mcp: Callable[[], Any] | None = None, transcript: Path | None = None,
                       before_stop: Callable[[], Any] | None = None) -> None:
        base = {"session_id": session_id, "cwd": str(cwd), "transcript_path": str(transcript or self.work / "never-read.jsonl")}
        tool_input = {"workspace_slug": self.seed["slug"], "board_id": self.seed["board_id"], "card_id": self.seed["card_id"],
                      "status": "in progress", "note": command, "plan": str(cwd / "docs" / "plan.md"),
                      "notes": str(self.companion.home / "notes.txt")}
        self.companion.hook("claude-code", {**base, "hook_event_name": "SessionStart", "source": "startup", "model": "claude-e2e"})
        self.companion.hook("claude-code", {**base, "hook_event_name": "UserPromptSubmit", "prompt": prompt})
        self.companion.hook("claude-code", {**base, "hook_event_name": "PreToolUse", "tool_name": "mcp__backplane__update_card",
                                            "tool_use_id": tool_use_id, "tool_input": tool_input})
        if mcp:
            mcp()
        self.companion.hook("claude-code", {**base, "hook_event_name": "PostToolUse", "tool_name": "mcp__backplane__update_card",
                                            "tool_use_id": tool_use_id, "tool_input": tool_input,
                                            "tool_response": [{"type": "text", "text": output}]})
        if before_stop:
            before_stop()
        self.companion.hook("claude-code", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
        self.companion.hook("claude-code", {**base, "hook_event_name": "SessionEnd", "reason": "exit"})

    # --- lifecycle -------------------------------------------------------

    def setup(self) -> None:
        self.postgres.start()
        self.postgres.recreate()
        self.backend.migrate()
        self.backend.start()

    def teardown(self) -> None:
        self.companion.stop_daemon()
        if self.paired:
            self.paired.stop_daemon()
            shutil.rmtree(self.paired.data, ignore_errors=True)
        self.backend.stop()
        self.postgres.drop_and_stop()
        if not self.args.keep_work:
            shutil.rmtree(self.work, ignore_errors=True)

    def scenario(self, name: str, body: Callable[[], Any]) -> bool:
        started = time.monotonic()
        try:
            evidence = body()
            self.results.append((name, "PASS", evidence))
            print(f"PASS {name} ({time.monotonic() - started:.1f}s)", flush=True)
            return True
        except Failure as failure:
            self.results.append((name, "FAIL", {"reason": str(failure), "evidence": trim(failure.evidence, 1500)}))
        except Exception as error:  # noqa: BLE001 - reported as a failed scenario
            self.results.append((name, "FAIL", {"reason": repr(error), "trace": traceback.format_exc()[-1500:]}))
        print(f"FAIL {name}: {self.results[-1][2]}", flush=True)
        return False

    # --- scenarios -------------------------------------------------------

    def seed_data(self) -> dict:
        me = self.api.call("GET", "/api/me")
        workspace = self.api.call("POST", "/api/workspaces", json={"name": "E2E", "slug": "e2e"})
        board = self.api.call("POST", f"/api/workspaces/{workspace['slug']}/boards", json={"name": "E2E board"})
        columns = self.api.call("GET", f"/api/workspaces/{workspace['slug']}/boards/{board['id']}")["columns"]
        card = self.api.call("POST", f"/api/workspaces/{workspace['slug']}/boards/{board['id']}/cards",
                             json={"title": "E2E card", "column_id": columns[0]["id"]})
        repo = self.api.call("POST", f"/api/workspaces/{workspace['slug']}/boards/{board['id']}/git-repos",
                             json={"name": "e2e-repo", "url": REPO_URL, "provider": "github"})
        key = self.api.call("POST", "/api/me/api-keys", json={"name": "e2e companion"})
        self.seed.update(user_id=me["id"], slug=workspace["slug"], board_id=board["id"], card_id=card["id"],
                         repo_id=repo["id"], api_key=key["raw_key"])
        self.mcp = McpClient(self.args.mcp_python, self.backend.url, key["raw_key"])
        return {"workspace": workspace["slug"], "board": board["id"], "card": card["id"], "repo_url": repo["url"]}

    def connect_and_run(self) -> dict:
        connect = self.companion.json("connect", "--endpoint", self.backend.url, "--allow-insecure-loopback",
                                      extra={"BACKPLANE_API_KEY": self.seed["api_key"]})
        check(connect.get("connected") is True and connect.get("policy_cached") is True, "connect", connect)
        self.seed["installation_id"] = connect["installation_id"]
        check("bpc_" not in json.dumps(connect) and self.seed["api_key"] not in (self.companion.data / "installation.json").read_text(encoding="utf-8"),
              "credentials leaked into output or state")
        agents = self.companion.json("agents", "install", "claude-code", "codex", "pi")
        states = {report["id"]: report["integration"]["state"] for report in agents}
        check(states.get("claude_code") == "installed" and states.get("pi_cli") == "installed", "agents install", agents)
        check(states.get("codex_cli") == "needs_trust", "codex hooks must await the user's trust", agents)
        self.companion.start_daemon()
        status = wait_for("healthy status", lambda: (lambda s: s if s["capture"]["state"] == "active" and s["connected"] else None)(self.companion.status()))
        return {"connect": {k: connect[k] for k in ("connected", "installation_id", "policy_cached")},
                "agents": states, "status": {"connected": status["connected"], "daemon_running": status["daemon_running"],
                                             "capture": status["capture"]["state"], "queue": status["queue"]["records"]}}

    def claude(self) -> dict:
        # Projects live under the (isolated) home directory, as on a real machine.
        repo = git_repo(self.companion.home / "code" / "e2e-repo", ORIGIN)
        self.seed["repo_path"] = repo
        meta = {"claudecode/toolUseId": "toolu_e2e_1"}
        update = {"workspace_slug": self.seed["slug"], "board_id": self.seed["board_id"], "card_id": self.seed["card_id"], "status": "in progress"}
        # Claude Code's hooks carry no usage; the companion reads it from the transcript at Stop. Usage counts only from
        # when capture was allowed, so the transcript is written once the auto-mapping reached the daemon.
        transcript = self.companion.home / ".claude" / "projects" / "-e2e-repo" / "claude-e2e-1.jsonl"
        transcript.parent.mkdir(parents=True, exist_ok=True)

        def write_transcript() -> None:
            mapping = wait_for("auto-mapping", lambda: next((m for m in self.mappings()
                                                              if m["repo_url_normalized"] == "github.com/e2e-org/e2e-repo"), None))
            wait_for("capture window open", lambda: self.capture_window_open(mapping["id"]))
            transcript.write_text(claude_transcript("claude-e2e-1"), encoding="utf-8")

        self.claude_session("claude-e2e-1", repo, "Update the E2E card to in progress", "status in progress",
                            "card updated", "toolu_e2e_1", mcp=lambda: self.mcp.call("claude-code", "update_card", update, meta),
                            transcript=transcript, before_stop=write_transcript)
        session = wait_for("claude session", lambda: (lambda s: s if s and s["event_count"] >= 6 and s["cost_usd"] is not None else None)(
            self.session("claude-e2e-1")))
        check((session["input_tokens"], session["output_tokens"], session["cache_read_tokens"], session["cache_creation_tokens"])
              == CLAUDE_TRANSCRIPT_TOKENS, "claude session must carry its transcript usage, each request once", session)
        # Claude Code never prices its usage: the cost is Backplane's estimate.
        check((session["cost_estimated_usd"] or 0) > 0 and session["cost_reported_usd"] is None
              and session["cost_source"] == "estimated" and session["cost_usd"] == session["cost_estimated_usd"]
              and session["service_tier"] == "standard" and session["cost_complete"] is True,
              "claude session must carry an estimated cost", session)
        check(self.postgres.dump().count(CLAUDE_TRANSCRIPT_SENTINEL) == 0, "transcript content reached the database", {})
        mappings = self.mappings()
        check(any(m["repo_url_normalized"] == "github.com/e2e-org/e2e-repo" and m["origin"] == "auto_repo"
                  and m["root_path"] is None for m in mappings),
              "auto-mapping not created", mappings)
        check(session["harness"] == "claude_code" and session["title"] and session["prompt_count"] >= 1
              and session["tool_call_count"] >= 1, "session summary", session)
        check(session["repository"] == "github.com/e2e-org/e2e-repo" and session["branch"] == E2E_BRANCH
              and session["cwd"] == ".", "session place", session)
        events = self.events(session["id"])
        times = [event["occurred_at"] for event in events]
        check(times == sorted(times), "timeline out of order", times)
        links = wait_for("card link", lambda: [l for l in self.links(session["id"]) if l["entity_id"] == self.seed["card_id"]])
        check(links[0]["relation"] == "changed", "card must be linked as changed", links)
        card_sessions = self.card_sessions()
        check(any(item["session"]["id"] == session["id"] and "changed" in item["relations"] for item in card_sessions["items"]),
              "card sessions do not list the session", card_sessions)
        return {"mapping": [{k: m[k] for k in ("root_path", "repo_url_normalized", "origin", "content_level")} for m in mappings],
                "session": {k: session[k] for k in ("harness", "repository", "branch", "cwd", "title", "model", "event_count", "prompt_count",
                                                    "tool_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
                                                    "cache_creation_tokens", "cost_usd", "cost_source", "service_tier", "status")},
                "events": [(e["action"], e["native_tool_call_id"]) for e in events],
                "links": [{k: l[k] for k in ("entity_type", "relation", "invocation_count")} for l in links],
                "card_sessions": trim(card_sessions, 400)}

    def codex(self) -> dict:
        repo = self.seed["repo_path"]
        base = {"transcript_path": None, "cwd": str(repo), "model": "gpt-5", "permission_mode": "default"}
        self.companion.hook("codex", {**base, "session_id": "thread-e2e", "hook_event_name": "SessionStart", "source": "startup"})
        self.companion.hook("codex", {**base, "session_id": "thread-e2e", "turn_id": "t1", "hook_event_name": "UserPromptSubmit",
                                      "prompt": "Read the E2E card"})
        self.companion.hook("codex", {**base, "session_id": "thread-e2e", "turn_id": "t1", "hook_event_name": "SubagentStart",
                                      "agent_id": "thread-e2e-child", "agent_type": "worker"})
        gate = self.companion.gate()
        self.post_otlp(gate + "/v1/logs", codex_logs())
        self.post_otlp(gate + "/v1/traces", codex_turn_span())
        read = {"workspace_slug": self.seed["slug"], "board_id": self.seed["board_id"], "card_id": self.seed["card_id"]}
        self.mcp.call("codex-mcp-client", "get_card", read, {"callId": "call_e2e_1"})
        session = wait_for("codex session with tokens", lambda: (lambda s: s if s and s["input_tokens"] else None)(self.session("thread-e2e")))
        check(session["harness"] == "codex_cli" and session["output_tokens"], "codex session", session)
        # Codex never prices its own usage: the cost is Backplane's estimate,
        # and a ChatGPT sign-in makes it an API-equivalent value, not spend.
        check((session["cost_estimated_usd"] or 0) > 0 and session["cost_reported_usd"] is None
              and session["cost_source"] == "estimated" and session["cost_usd"] == session["cost_estimated_usd"],
              "codex session must carry an estimated cost", session)
        check(session["auth_kind"] == "subscription" and session["cost_basis"] == "api_equivalent",
              "codex ChatGPT sign-in is a subscription", session)
        links = wait_for("codex card link", lambda: [l for l in self.links(session["id"]) if l["entity_id"] == self.seed["card_id"]])
        check(links[0]["relation"] == "consulted", "card must be linked as consulted", links)
        child = wait_for("subagent session", lambda: self.session("thread-e2e-child"))
        check(child["parent_session_id"] == session["id"], "subagent parent", child)
        return {"session": {k: session[k] for k in ("harness", "input_tokens", "output_tokens", "event_count", "tool_call_count",
                                                    "cost_usd", "cost_source", "auth_kind", "cost_basis")},
                "links": [{k: l[k] for k in ("relation", "invocation_count")} for l in links],
                "subagent": {"native_session_id": child["native_session_id"], "parent_session_id": child["parent_session_id"]}}

    def post_otlp(self, url: str, body: dict) -> None:
        def accepted() -> bool:
            try:
                return httpx.post(url, json=body, timeout=5).status_code == 200
            except httpx.HTTPError:
                return False
        wait_for(f"gate accepts {url}", accepted, timeout=30)

    def pi(self) -> dict:
        repo = self.seed["repo_path"]
        for event in pi_events(str(repo)):
            self.companion.hook("pi", event)
        session = wait_for("pi session", lambda: (lambda s: s if s and s["event_count"] >= 8 else None)(self.session("pi-e2e-1")))
        check(session["harness"] == "pi_cli", "pi harness", session)
        events = self.events(session["id"])
        actions = [event["action"] for event in events]
        for action in ("session.started", "prompt.submitted", "tool.invoked", "command.executed", "token.usage", "session.ended"):
            check(action in actions, f"pi timeline lacks {action}", actions)
        check(self.links(session["id"]) == [], "pi has no MCP, so no links", self.links(session["id"]))
        check(session["cost_reported_usd"] == PI_REPORTED_COST and session["cost_usd"] == PI_REPORTED_COST
              and session["cost_source"] == "reported", "pi session must carry its reported cost", session)
        return {"session": {k: session[k] for k in ("harness", "event_count", "prompt_count", "tool_call_count", "input_tokens",
                                                    "cost_usd", "cost_source", "auth_kind")},
                "actions": actions}

    def privacy(self) -> dict:
        mapping = next(m for m in self.mappings() if m["repo_url_normalized"] == "github.com/e2e-org/e2e-repo")
        patched = self.api.call("PATCH", f"/api/me/companion/installations/{self.seed['installation_id']}/mappings/{mapping['id']}",
                                json={"content_level": "metadata"})
        check(patched["content_level"] == "metadata", "patch mapping", patched)
        # The daemon picks the new level up at its next policy refresh.
        self.companion.stop_daemon()
        self.companion.start_daemon()
        wait_for("metadata policy cached", lambda: any(m.get("content_level") == "metadata"
                                                           for m in json.loads((self.companion.data / "policy.json").read_text(encoding="utf-8"))["policy"]["mappings"]))
        sentinels = ["SENTINEL_PROMPT_7c1", "SENTINEL_COMMAND_7c1", "SENTINEL_OUTPUT_7c1"]
        self.claude_session("claude-e2e-meta", self.seed["repo_path"], sentinels[0], sentinels[1], sentinels[2], "toolu_e2e_meta")
        wait_for("metadata session", lambda: (lambda s: s if s and s["event_count"] >= 6 else None)(self.session("claude-e2e-meta")))
        dump = self.postgres.dump()
        leaks = {sentinel: dump.count(sentinel) for sentinel in sentinels}
        # Positive control: the same scan finds the standard-level command stored by the Claude scenario.
        check(dump.count("status in progress") > 0, "pg_dump scan cannot see standard-level content", {})
        check(all(count == 0 for count in leaks.values()), "metadata content stored in the database", leaks)

        other = git_repo(self.companion.home / "code" / "unmapped", UNMAPPED_ORIGIN)
        before = self.postgres.query("select count(*) from agent_sessions")[0][0]
        self.companion.hook("claude-code", {"session_id": "claude-e2e-unmapped", "cwd": str(other), "hook_event_name": "UserPromptSubmit",
                                            "prompt": "SENTINEL_UNMAPPED_7c1"})
        status = wait_for("unmapped repo discovered", lambda: (lambda s: s if any(p.get("repo_url") == "github.com/someone-else/private-repo"
                                                                                    for p in s["pending_projects"]) else None)(self.companion.status()))
        time.sleep(3)
        after = self.postgres.query("select count(*) from agent_sessions")[0][0]
        stored = self.postgres.dump().count("SENTINEL_UNMAPPED_7c1")
        check(before == after and stored == 0, "unmapped repo uploaded", {"before": before, "after": after, "stored": stored})
        leftovers = [p for p in self.companion.data.rglob("*") if p.is_file() and "SENTINEL_UNMAPPED_7c1" in p.read_text(encoding="utf-8", errors="ignore")]
        check(leftovers == [], "unmapped content retained locally", [str(p) for p in leftovers])
        return {"mapping": {"content_level": patched["content_level"]}, "sentinel_occurrences_in_pg_dump": leaks,
                "unmapped": {"sessions_before": before, "sessions_after": after,
                             "discovered": [p for p in status["pending_projects"] if "someone-else" in p.get("repo_url", "")]}}

    def resilience(self) -> dict:
        evidence: dict[str, Any] = {}
        self.backend.stop()
        self.claude_session("claude-e2e-offline", self.seed["repo_path"], "offline prompt", "offline", "offline output", "toolu_e2e_off")
        time.sleep(4)
        queued = self.companion.status()["queue"]
        check(queued["records"] > 0 or self.companion.status()["queue"]["inbox_items"] > 0, "nothing queued while offline", queued)
        self.backend.start()
        session = wait_for("offline session uploaded", lambda: (lambda s: s if s and s["event_count"] >= 6 else None)(self.session("claude-e2e-offline")), timeout=120)
        time.sleep(5)
        again = self.session("claude-e2e-offline")
        rows = self.postgres.query("select count(*) from agent_session_events e join agent_sessions s on s.id = e.session_id "
                                   "where s.native_session_id = 'claude-e2e-offline'")[0][0]
        check(again["event_count"] == session["event_count"] and int(rows) == session["event_count"], "counts doubled after replay",
              {"first": session["event_count"], "later": again["event_count"], "rows": rows})
        evidence["offline"] = {"queued_while_down": queued["records"], "event_count": again["event_count"], "event_rows": rows}

        revoked = self.api.call("DELETE", f"/api/me/companion/installations/{self.seed['installation_id']}")
        # The daemon learns of the revocation from its next upload (401) or policy refresh.
        self.companion.hook("claude-code", {"session_id": "claude-e2e-revoked", "cwd": str(self.seed["repo_path"]),
                                            "hook_event_name": "UserPromptSubmit", "prompt": "just after revocation"})
        status = wait_for("unauthorized after revocation", lambda: (lambda s: s if s["capture"]["unauthorized"] else None)(self.companion.status()), timeout=120)
        before = self.companion.status()["queue"]["inbox_items"]
        self.companion.hook("claude-code", {"session_id": "claude-e2e-revoked", "cwd": str(self.seed["repo_path"]),
                                            "hook_event_name": "UserPromptSubmit", "prompt": "after revocation"})
        after = self.companion.status()["queue"]["inbox_items"]
        check(after == before, "admission continued after revocation", {"before": before, "after": after})
        check(self.session("claude-e2e-revoked") is None, "a revoked device uploaded", self.session("claude-e2e-revoked"))
        evidence["revoked"] = {"revoked_at": bool(revoked.get("revoked_at")), "capture": status["capture"]["state"],
                               "unauthorized": status["capture"]["unauthorized"], "inbox_before_after": [before, after]}

        self.companion.stop_daemon()
        self.companion.json("disconnect")
        reconnect = self.companion.json("connect", "--endpoint", self.backend.url, "--allow-insecure-loopback",
                                        extra={"BACKPLANE_API_KEY": self.seed["api_key"]})
        check(reconnect["connected"] and reconnect["installation_id"] != self.seed["installation_id"], "reconnect", reconnect)
        self.seed["installation_id"] = reconnect["installation_id"]
        self.companion.start_daemon()
        wait_for("active after reconnect", lambda: self.companion.status()["capture"]["state"] == "active")
        evidence["reconnect"] = {"new_installation": reconnect["installation_id"] != revoked["installation_id"], "capture": "active"}
        return evidence

    def no_local_paths(self) -> dict:
        dump = self.postgres.dump()
        found = {marker: dump.count(marker) for marker in LOCAL_PATH_MARKERS}
        offending = [line[:300] for line in dump.splitlines() if any(marker in line for marker in LOCAL_PATH_MARKERS)]
        check(not any(found.values()), "a local path is stored in the database", offending[:5])
        # Positive control: the scan sees the relative paths the companion sent.
        check("docs/plan.md" in dump and "~/notes.txt" in dump, "pg_dump scan cannot see placed paths", {})
        return {"occurrences_in_pg_dump": found}

    def deleted_session(self) -> dict:
        repo = self.seed["repo_path"]
        base = {"session_id": "claude-e2e-deleted", "cwd": str(repo)}
        self.companion.hook("claude-code", {**base, "hook_event_name": "SessionStart", "source": "startup", "model": "claude-e2e"})
        session = wait_for("session to delete", lambda: self.session("claude-e2e-deleted"))
        # Stop the daemon so the next capture waits locally while the owner deletes.
        self.companion.stop_daemon()
        self.api.call("DELETE", f"/api/workspaces/{self.seed['slug']}/sessions/{session['id']}", expect=(204,))
        self.companion.hook("claude-code", {**base, "hook_event_name": "UserPromptSubmit", "prompt": "after deletion"})
        self.companion.start_daemon()
        queue = wait_for("dropped ack", lambda: (lambda q: q if q.get("drop_reasons", {}).get("session_deleted") else None)(self.companion.status()["queue"]))
        check(queue["records"] == 0 and queue["inbox_items"] == 0, "dropped capture kept locally", queue)
        check(self.session("claude-e2e-deleted") is None, "deleted session recreated", self.sessions())
        # Further captures of the deleted session are suppressed, not uploaded.
        self.companion.hook("claude-code", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
        health = wait_for("suppressed capture", lambda: (lambda h: h if h.get("suppressed_deleted") else None)(self.companion.status()["health"]))
        rows = self.postgres.query("select count(*) from agent_sessions where native_session_id = 'claude-e2e-deleted'")[0][0]
        check(str(rows) == "0" and self.session("claude-e2e-deleted") is None, "deleted session recreated", rows)
        installation = wait_for("heartbeat", lambda: next((item for item in self.api.call("GET", "/api/me/companion/installations")
                                                           if item["installation_id"] == self.seed["installation_id"] and item.get("status")), None))
        heartbeat = installation["status"]
        check(heartbeat["companion_version"] and installation["status_reported_at"] and installation["last_seen_at"], "heartbeat", installation)
        check(not any(marker in json.dumps(heartbeat) for marker in LOCAL_PATH_MARKERS), "local path in heartbeat", heartbeat)
        return {"dropped": {"drop_reasons": queue["drop_reasons"], "records": queue["records"], "inbox_items": queue["inbox_items"]},
                "suppressed_deleted": health["suppressed_deleted"], "session_rows": rows,
                "heartbeat": {"status": heartbeat, "status_reported_at": installation["status_reported_at"]}}

    def pairing(self) -> dict:
        """A second device, never given an API key, paired by browser code through its daemon's control API."""
        # A Unix socket path must fit in about 104 bytes, which a data directory under the work root does not leave;
        # only project directories must stay out of temp directories, and those live under the work root.
        data = Path(tempfile.mkdtemp(prefix="bpp-", dir="/tmp"))
        self.paired = paired = Companion(Path(self.companion.binary), self.work / "paired", self.args.beacon_artifact,
                                         self.args.otelcol_artifact, data=data)
        paired.env["BACKPLANE_COMPANION_ALLOW_INSECURE_LOOPBACK"] = "1"
        paired.start_daemon()
        wait_for("control API", lambda: (data / "control.json").exists())
        control = ControlClient(data)
        status, before = control.call("GET", "/v1/status")
        check(status == 200 and before["connected"] is False, "the daemon must wait unconnected", before)
        installations = {item["installation_id"] for item in self.api.call("GET", "/api/me/companion/installations")}

        def start() -> dict:
            status, started = control.call("POST", "/v1/pair/start", json={"endpoint": self.backend.url, "name": "e2e paired"})
            check(status == 200 and started.get("user_code") and started.get("pairing_id"), "pair/start", started)
            return started

        def settle(pairing_id: str) -> tuple[int, Any]:
            return wait_for("pairing to settle", lambda: (lambda reply: reply if reply[0] != 202 else None)(
                control.call("GET", f"/v1/pair/{pairing_id}")))

        refused = start()
        request = self.api.call("POST", "/api/me/companion/pairing/lookup", json={"user_code": refused["user_code"]})
        check(request["state"] == "pending" and request["name"] == "e2e paired", "lookup of the pending request", request)
        self.api.call("POST", "/api/me/companion/pairing/deny", json={"user_code": refused["user_code"]})
        status, denied = settle(refused["pairing_id"])
        check(status == 403 and denied["error"]["code"] == "pairing_denied", "a denied pairing", denied)
        after_deny = {item["installation_id"] for item in self.api.call("GET", "/api/me/companion/installations")}
        check(not paired.status()["connected"] and not (data / "installation.json").exists() and after_deny == installations,
              "a denied pairing connected something", sorted(after_deny - installations))

        granted = start()
        self.api.call("POST", "/api/me/companion/pairing/approve", json={"user_code": granted["user_code"]})
        status, connected = settle(granted["pairing_id"])
        check(status == 200 and connected["connected"] is True and connected["installation_id"] not in installations,
              "an approved pairing", connected)
        installation_id = connected["installation_id"]
        listed = next((item for item in self.api.call("GET", "/api/me/companion/installations")
                       if item["installation_id"] == installation_id), None)
        check(listed is not None and listed["name"] == "e2e paired", "the paired installation on the server", listed)
        paired.json("agents", "install", "claude-code")
        # No daemon restart: the daemon that paired starts its capture session by itself.
        status_after = wait_for("paired capture active", lambda: (lambda s: s if s["connected"] and s["capture"]["state"] == "active"
                                                                   else None)(paired.status()))
        repo = git_repo(paired.home / "code" / "e2e-repo", ORIGIN)
        base = {"session_id": "claude-e2e-paired", "cwd": str(repo), "transcript_path": str(self.work / "never-read.jsonl")}
        paired.hook("claude-code", {**base, "hook_event_name": "SessionStart", "source": "startup", "model": "claude-e2e"})
        paired.hook("claude-code", {**base, "hook_event_name": "UserPromptSubmit", "prompt": "paired through the control API"})
        paired.hook("claude-code", {**base, "hook_event_name": "Stop", "stop_hook_active": False})
        paired.hook("claude-code", {**base, "hook_event_name": "SessionEnd", "reason": "exit"})
        session = wait_for("paired session", lambda: (lambda s: s if s and s["event_count"] >= 4 else None)(self.session("claude-e2e-paired")))
        check(session["installation_id"] == installation_id and session["harness"] == "claude_code"
              and session["repository"] == "github.com/e2e-org/e2e-repo", "session captured by the paired device", session)
        return {"denied": {"status": 403, "code": denied["error"]["code"], "installations_unchanged": after_deny == installations},
                "approved": {"status": status, "new_installation": installation_id not in installations, "name": listed["name"]},
                "capture": {"state": status_after["capture"]["state"], "daemon_restarted": False},
                "session": {k: session[k] for k in ("harness", "repository", "event_count", "prompt_count")}}

    def other_member(self) -> dict:
        self.api.call("GET", "/api/me", email=OTHER)
        self.api.call("POST", f"/api/workspaces/{self.seed['slug']}/members", json={"email": OTHER, "role": "member"})
        listed = self.card_sessions(email=OTHER, expect=(200, 404))
        sessions = self.api.call("GET", f"/api/workspaces/{self.seed['slug']}/sessions", email=OTHER, expect=(200, 404))
        check(listed is None or listed.get("items") in ([], None) or "detail" in listed, "another member sees card sessions", listed)
        check(sessions is None or sessions.get("items") in ([], None) or "detail" in sessions, "another member sees sessions", sessions)
        return {"card_sessions": trim(listed, 200), "sessions": trim(sessions, 200)}

    def report(self) -> int:
        print("\n| Scenario | Result |\n|---|---|")
        for name, verdict, _ in self.results:
            print(f"| {name} | {verdict} |")
        print("\nEVIDENCE")
        print(json.dumps({name: evidence for name, _, evidence in self.results}, indent=2, default=str))
        return 0 if all(verdict == "PASS" for _, verdict, _ in self.results) else 1


def codex_logs() -> dict:
    def attribute(key: str, value: str) -> dict:
        return {"key": key, "value": {"stringValue": value}}

    def record(thread: str, event: str, *extra: dict) -> dict:
        return {"timeUnixNano": str(time.time_ns()), "body": {"stringValue": event},
                "attributes": [attribute("event.name", event), attribute("conversation.id", thread),
                               attribute("user.email", "person@example.com"), attribute("app.version", "0.144.1"),
                               attribute("model", "gpt-5"), attribute("auth_mode", "Chatgpt"), *extra]}

    return {"resourceLogs": [{"resource": {"attributes": [attribute("service.name", "codex_exec")]},
                              "scopeLogs": [{"scope": {"name": "codex_otel.log_only"}, "logRecords": [
                                  record("thread-e2e", "codex.conversation_starts", attribute("provider_name", "openai")),
                                  record("thread-e2e", "codex.user_prompt", attribute("prompt", "Read the E2E card")),
                                  record("thread-e2e", "codex.tool_result", attribute("tool_name", "mcp__backplane__get_card"),
                                         attribute("call_id", "call_e2e_1"), attribute("arguments", "{}"),
                                         attribute("success", "true"), attribute("output", "card body")),
                                  record("thread-e2e-child", "codex.user_prompt", attribute("prompt", "subagent work")),
                              ]}]}]}


def codex_turn_span() -> dict:
    now = time.time_ns()

    def attribute(key: str, value: Any) -> dict:
        return {"key": key, "value": {"intValue": str(value)} if isinstance(value, int) else {"stringValue": value}}

    return {"resourceSpans": [{"resource": {"attributes": [attribute("service.name", "codex_exec")]}, "scopeSpans": [{
        "scope": {"name": "codex"}, "spans": [{
            "traceId": uuid.uuid4().hex, "spanId": uuid.uuid4().hex[:16], "name": "turn", "kind": 1,
            "startTimeUnixNano": str(now - 2_000_000_000), "endTimeUnixNano": str(now),
            "attributes": [attribute("thread.id", "thread-e2e"), attribute("turn.id", "turn-1"), attribute("model", "gpt-5"),
                           attribute("codex.turn.token_usage.input_tokens", 1200),
                           attribute("codex.turn.token_usage.output_tokens", 340),
                           attribute("codex.turn.token_usage.total_tokens", 1540)], "status": {}}]}]}]}


CLAUDE_TRANSCRIPT_SENTINEL = "SENTINEL_TRANSCRIPT_7c1"
# (input, output, cache read, cache creation) of claude_transcript(), each request counted once.
CLAUDE_TRANSCRIPT_TOKENS = (3 + 5, 420 + 60, 12000 + 15000, 3000 + 0)


def claude_transcript(session_id: str) -> str:
    """A Claude Code transcript as it is written: one line per content block, each repeating its request's usage,
    which grows to its final output count on the last block."""
    # Millisecond precision: a stamp truncated to the second could fall before the capture window opened.
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"

    def assistant(message_id: str, request_id: str, block: dict, input_tokens: int, output: int, cache_read: int,
                  five_minute: int, one_hour: int) -> dict:
        return {"type": "assistant", "sessionId": session_id, "timestamp": stamp, "requestId": request_id, "version": "2.1.0",
                "message": {"id": message_id, "role": "assistant", "model": "claude-sonnet-4-5-20250929", "content": [block],
                            "usage": {"input_tokens": input_tokens, "output_tokens": output, "cache_read_input_tokens": cache_read,
                                      "cache_creation_input_tokens": five_minute + one_hour, "service_tier": "standard",
                                      "cache_creation": {"ephemeral_5m_input_tokens": five_minute, "ephemeral_1h_input_tokens": one_hour}}}}

    lines = [
        {"type": "user", "sessionId": session_id, "timestamp": stamp,
         "message": {"role": "user", "content": f"{CLAUDE_TRANSCRIPT_SENTINEL} prompt"}},
        assistant("msg_e2e_1", "req_e2e_1", {"type": "thinking", "thinking": f"{CLAUDE_TRANSCRIPT_SENTINEL} thinking"}, 3, 1, 12000, 1000, 2000),
        assistant("msg_e2e_1", "req_e2e_1", {"type": "tool_use", "id": "toolu_e2e_1", "name": "mcp__backplane__update_card",
                                             "input": {"note": f"{CLAUDE_TRANSCRIPT_SENTINEL} tool input"}}, 3, 420, 12000, 1000, 2000),
        assistant("msg_e2e_2", "req_e2e_2", {"type": "text", "text": f"{CLAUDE_TRANSCRIPT_SENTINEL} answer"}, 5, 60, 15000, 0, 0),
    ]
    return "".join(json.dumps(line) + "\n" for line in lines)


PI_REPORTED_COST = 0.001


def pi_events(cwd: str) -> list[dict]:
    base = {"sessionId": "pi-e2e-1", "cwd": cwd}
    return [
        {**base, "type": "session_start", "reason": "startup", "model": "anthropic/claude-e2e"},
        {**base, "type": "input", "text": "Run the tests", "source": "interactive"},
        {**base, "type": "tool_call", "toolName": "bash", "toolCallId": "pi_call_1", "input": {"command": "make test"}},
        {**base, "type": "tool_result", "toolName": "bash", "toolCallId": "pi_call_1", "input": {"command": "make test"},
         "content": [{"type": "text", "text": "ok"}], "isError": False},
        {**base, "type": "user_bash", "command": "git status", "excludeFromContext": False},
        {**base, "type": "message_end", "message": {"role": "assistant", "provider": "anthropic", "model": "claude-e2e",
                                                     "content": [{"type": "thinking", "thinking": "plan"}, {"type": "text", "text": "done"}],
                                                     "usage": {"input": 90, "output": 12, "cacheRead": 0, "cacheWrite": 0,
                                                               "cost": {"total": PI_REPORTED_COST}}}},
        {**base, "type": "session_shutdown", "reason": "quit"},
    ]


# Absolute but never symlink-resolved: a venv's bin/python must stay the venv's.
PATH_ARGUMENTS = ("pg_root", "beacon_artifact", "otelcol_artifact", "work_root")
# A bare interpreter name (python3) stays as given for PATH lookup.
COMMAND_ARGUMENTS = ("backend_python", "mcp_python")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pg-root", required=True)
    parser.add_argument("--beacon-artifact", required=True)
    parser.add_argument("--otelcol-artifact", required=True)
    parser.add_argument("--backend-python", default=str(Path.home() / "Programming/valaris/internal/backend/.venv/bin/python"))
    parser.add_argument("--mcp-python", default=sys.executable)
    parser.add_argument("--work-root", default=str(Path.home() / "Library" / "Caches"),
                        help="parent of the throwaway run directory; must not be a temp directory")
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args(argv)
    for name in PATH_ARGUMENTS:
        setattr(args, name, os.path.abspath(getattr(args, name)))
    for name in COMMAND_ARGUMENTS:
        value = getattr(args, name)
        if os.sep in value or (os.altsep and os.altsep in value):
            setattr(args, name, os.path.abspath(value))
    return args


def main() -> int:
    # Failure evidence carries arbitrary text; a cp1252 console must not crash the report.
    sys.stdout.reconfigure(errors="backslashreplace")
    run = Run(parse_args())
    try:
        run.setup()
        steps = [("0 seed", run.seed_data), ("1 connect/install/run/status", run.connect_and_run), ("2 claude + MCP link", run.claude),
                 ("3 codex + MCP link + subagent", run.codex), ("4 pi", run.pi), ("5 privacy", run.privacy),
                 ("6 resilience", run.resilience), ("7 other member", run.other_member), ("8 deleted session", run.deleted_session),
                 ("9 pairing via control API", run.pairing), ("10 no local paths", run.no_local_paths)]
        for name, body in steps:
            if not run.scenario(name, body) and name.startswith(("0", "1")):
                break
        return run.report()
    finally:
        run.teardown()


if __name__ == "__main__":
    sys.exit(main())
