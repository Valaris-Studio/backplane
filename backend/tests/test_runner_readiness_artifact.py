# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in built-artifact qualification against real FastAPI, auth and SQL.

BACKPLANE_RUNNER_BIN must name an already-built artifact. No build, real forge,
model service, background worker or persistent operator configuration is used.
"""

import asyncio
from contextlib import contextmanager
import hashlib
import gzip
import json
import os
from pathlib import Path
import signal
import shutil
import shlex
import socket
import subprocess
import sys
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from starlette.responses import Response
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import create_async_engine
import uvicorn
import yaml

from app.database import get_db
from app.main import create_app
from app.models.agents.execution import AgentExecution
from app.models.base import Base
from app.models.kanban.completion import CompletionAttempt, CompletionCandidate
from app.schemas.kanban.loop import LOOP_CONFIG_DEFAULTS
from tests.test_agent_workspace_scope import _make_agent_with_key
from tests.test_completion_readiness import (
    PLATFORM_TOKEN,
    RAW_ERROR,
    REPO_PATH,
    WORKSPACE_TOKEN,
    completion_fixture,
    forge_http,
    readiness_fixture,
)
from tests.test_postmerge_acceptance import policy, status, submit
from tests.runner_fixture_database import sealed_database
from tests.runner_fixture_git import fixture_git_environment
from tests.runner_fixture_terminal import OwnedTerminal, TerminalDriver

__all__ = ["completion_fixture", "forge_http", "readiness_fixture"]
pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(
        not os.environ.get("BACKPLANE_RUNNER_BIN"),
        reason="set BACKPLANE_RUNNER_BIN to qualify an exact built artifact",
    ),
]


@pytest_asyncio.fixture
async def db_engine(tmp_path):
    # HTTP and WebSocket requests need independent transactions; a private file
    # avoids StaticPool's shared-connection rollback interaction under overlap.
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'fixture.sqlite'}")

    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def sealed_artifact_database(monkeypatch, db_engine):
    with sealed_database(monkeypatch, db_engine) as factory:
        yield factory


class FixtureServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        yield  # pytest owns signals; this server is an asyncio fixture task.


def write_executable(path, content):
    path.write_text(content)
    path.chmod(0o700)


def write_provider(path, version, body):
    model = path.with_name(path.name + "-model.py")
    write_executable(model, body)
    write_executable(
        path,
        '#!/bin/sh\nif [ "$#" = 1 ]; then\n'
        ' case "$1" in --version|--help) printf "%s\\n" '
        + shlex.quote(version)
        + "; exit 0;; esac\n"
        "fi\nexec " + shlex.quote(str(model)) + ' "$@"\n',
    )


@pytest.mark.timeout(120)
@pytest.mark.parametrize(
    "scenario",
    [
        "pr-denied",
        "review",
        "validation",
        "missing-runtime",
        "budget-history",
        "recovery",
        pytest.param("interactive", marks=pytest.mark.timeout(650)),
        pytest.param("interactive-fresh", marks=pytest.mark.timeout(650)),
    ],
)
async def test_built_runner_real_api_readiness_and_preserved_completion(
    client,
    agent_client,
    readiness_fixture,
    forge_http,
    test_user,
    tmp_path,
    scenario,
    sealed_artifact_database,
):
    f = readiness_fixture
    interactive_dir = os.environ.get("BACKPLANE_RUNNER_INTERACTIVE_DIR")
    artifact = Path(os.environ["BACKPLANE_RUNNER_BIN"]).resolve(strict=True)
    assert artifact.is_file() and os.access(artifact, os.X_OK)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    version = subprocess.run(
        [str(artifact), "-version"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    ).stdout.strip()
    print(
        json.dumps(
            {
                "artifact_sha256": digest,
                "version": version,
                "scenario": scenario,
                "artifact_kind": os.environ.get(
                    "BACKPLANE_RUNNER_ARTIFACT_KIND", "operator-supplied-artifact"
                ),
            }
        )
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    source_marker = tmp_path / "source-invoked"
    review_marker = tmp_path / "review-sha"
    review_args = tmp_path / "review-argv"
    check_marker = tmp_path / "check-sha"
    write_executable(
        bin_dir / "gh",
        "#!/bin/sh\necho 'Fixture completion must use the server-side forge client' >&2\nexit 78\n",
    )
    write_provider(
        bin_dir / "claude",
        "2.1.0 (Claude Code)",
        f"#!{sys.executable}\nimport sys\nfrom pathlib import Path\n"
        "if sys.argv[1:] in (['--version'], ['--help']): print('2.1.0 (Claude Code)'); raise SystemExit(0)\n"
        f"Path({str(source_marker)!r}).write_text('unexpected source work')\nraise SystemExit(74)\n",
    )
    write_provider(
        bin_dir / "codex",
        "codex-cli 0.144.1",
        f"#!{sys.executable}\nimport json,subprocess,sys\nfrom pathlib import Path\n"
        "if sys.argv[1:] in (['--version'], ['--help']): print('codex-cli 0.144.1'); raise SystemExit(0)\n"
        f"Path({str(review_marker)!r}).write_text(subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip())\n"
        f"Path({str(review_args)!r}).write_text(json.dumps(sys.argv[1:]))\n"
        "print(json.dumps({'type':'thread.started','thread_id':'fixture-review'}))\n"
        "print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps({'outcome':'passed','summary':'Exact fixture candidate independently reviewed.'})}}))\n"
        "print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))\n",
    )
    if scenario == "missing-runtime":
        resources = tmp_path / "Fixture.app" / "Contents" / "Resources"
        resources.mkdir(parents=True)
        (bin_dir / "codex").rename(resources / "codex")
        write_executable(resources / "codex-code-mode-host", "#!/bin/sh\nexit 0\n")
        (bin_dir / "codex").symlink_to(resources / "codex")
    write_executable(
        bin_dir / "fixture-check",
        f"#!{sys.executable}\nimport subprocess\nfrom pathlib import Path\n"
        f"Path({str(check_marker)!r}).write_text(subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip())\n"
        "print('Exact fixture revision checked.')\n",
    )
    git_env = fixture_git_environment()
    source = tmp_path / "source"
    source.mkdir()

    def git(*args):
        return subprocess.run(
            ["git", "-C", str(source), *args],
            env=git_env,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        ).stdout.strip()

    git("init", "-b", "main")
    (source / "candidate.txt").write_text("preserved candidate\n")
    git("add", "candidate.txt")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "candidate",
    )
    sha = git("rev-parse", "HEAD")
    (source / "landed.txt").write_text("distinct landed candidate\n")
    git("add", "landed.txt")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "landed candidate",
    )
    merge_sha = git("rev-parse", "HEAD")
    (source / "later.txt").write_text("main advanced after landing\n")
    git("add", "later.txt")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "later main",
    )
    later_sha = git("rev-parse", "HEAD")
    assert len({sha, merge_sha, later_sha}) == 3
    bare = tmp_path / "remote.git"
    git("clone", "--bare", str(source), str(bare))
    # The runner correctly scrubs ambient GIT_CONFIG_* injection. A fixture-only
    # executable delegates to real git with explicit local transport options;
    # all network protocols are denied even if a fixture URL changes.
    real_git = shutil.which("git")
    assert real_git
    git_prefix = [
        real_git,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-c",
        f"url.{bare}.insteadOf=https://github.com/valaris/test-repo",
    ]
    write_executable(
        bin_dir / "git",
        f"#!{sys.executable}\nimport os,sys\nfrom pathlib import Path\n"
        "kind=next((arg for arg in sys.argv[1:] if arg in {'clone','fetch','rev-parse','checkout','status','cat-file','symbolic-ref'}),'other')\n"
        f"with Path({str(tmp_path / 'git-operations')!r}).open('a') as log: log.write(kind+'\\n')\n"
        f"os.execv({real_git!r}, {git_prefix!r} + sys.argv[1:])\n",
    )
    forge_http.head_sha = sha
    forge_http.merge_sha = merge_sha

    selected_policy = policy(
        postmerge_validation={
            "role": "custom-validation",
            "checks": [
                {
                    "id": "exact-revision",
                    "argv": ["fixture-check"],
                    "timeout_seconds": 10,
                }
            ],
        },
        auto_complete=False,
    )
    if scenario == "validation":
        selected_policy.update(
            source_review="none", review_role=None, evidence_only={"enabled": False}
        )
    updated = await client.put(f"{f.url}/policy", json={"policy": selected_policy})
    assert updated.status_code == 200, updated.text
    if scenario == "recovery":
        from tests.test_completion_execution_boundaries import _configure_role

        await _configure_role(f)
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status(head=sha)),
    ):
        saved = await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    if scenario == "validation":
        candidate.status = "awaiting_validation"
        candidate.merge_sha = merge_sha
        forge_http.merged = True
    if scenario == "pr-denied":
        forge_http.statuses[f"{REPO_PATH}/pulls"] = 403
    f.board.loop_config = {
        **LOOP_CONFIG_DEFAULTS,
        "enabled": True,
        "provider": "claude-cli",
        "model": "saved-source-model",
        "loop_prompt": "Resume only the preserved fixture candidate.",
        "starvation_policy": "always_run",
        "budget_usd": 10,
        "max_iterations": 1,
        "iteration_delay_seconds": 1,
        "iteration_timeout_seconds": 10,
    }
    raw_key = await _make_agent_with_key(
        f.db, test_user, allowed_workspaces=["default"], name="artifact-runner"
    )
    await f.db.flush()
    await f.db.commit()
    app = create_app()

    async def fixture_db():
        async with sealed_artifact_database() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = fixture_db
    receipt_received = asyncio.Event()
    work_read = asyncio.Event()
    drifted = False
    result_receipts = []
    first_result = None
    requests = []

    @app.middleware("http")
    async def record_boundary(request, call_next):
        nonlocal drifted, first_result
        requests.append((request.method, request.url.path))
        if scenario == "budget-history" and request.url.path.endswith("/loop/history"):
            return Response("fixture history unavailable", status_code=503)
        if (
            scenario == "recovery"
            and request.url.path.endswith("/result")
            and not drifted
        ):
            first_result = (request.url.path, await request.json())
            from app.models.agents.prompt_config import AgentPromptConfig

            async with sealed_artifact_database() as session:
                prompt = await session.scalar(
                    select(AgentPromptConfig).where(
                        AgentPromptConfig.slug == "operator-assessment"
                    )
                )
                prompt.content += " A newly required inspection."
                prompt.version += 1
                await session.commit()
            drifted = True
        response = await call_next(request)
        if request.url.path.endswith("/completion/work"):
            work_read.set()
        if request.url.path.endswith("/result") and response.status_code == 200:
            body = b"".join([chunk async for chunk in response.body_iterator])
            decoded = (
                gzip.decompress(body)
                if response.headers.get("content-encoding") == "gzip"
                else body
            )
            result_receipts.append(json.loads(decoded).get("result_receipt"))
            response = Response(
                body, status_code=response.status_code, headers=dict(response.headers)
            )
            receipt_received.set()
        return response

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = FixtureServer(
        uvicorn.Config(app, log_level="error", lifespan="off", access_log=False)
    )
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    process = None
    terminal = None
    stdout = b""
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.01)
        api_url = f"http://127.0.0.1:{port}"
        loop_url = f"{api_url}/api/workspaces/default/boards/{f.board.id}/loop"
        mcp_script = bin_dir / "fixture-mcp"
        write_executable(
            mcp_script,
            f"#!{sys.executable}\n"
            "import json,os,sys,urllib.request\n"
            "for line in sys.stdin:\n"
            " msg=json.loads(line); method=msg.get('method'); ident=msg.get('id')\n"
            " if ident is None: continue\n"
            " if method=='initialize': result={'protocolVersion':'2024-11-05','serverInfo':{'name':'fixture-api-forwarder','version':'0.8.0'}}\n"
            " elif method=='tools/list': result={'tools':[{'name':name} for name in ['get_board_loop','get_completion_policy','get_completion_status','submit_completion_candidate','request_landing','retry_completion']]}\n"
            " elif method=='tools/call':\n"
            "  req=urllib.request.Request(os.environ['FIXTURE_LOOP_URL'],headers={'Authorization':'Bearer '+os.environ['FIXTURE_API_KEY'],'X-Backplane-Completion-Version':'1'})\n"
            "  with urllib.request.urlopen(req,timeout=5) as response: body=response.read().decode()\n"
            "  result={'content':[{'type':'text','text':body}]}\n"
            " else: raise RuntimeError('unexpected fixture MCP method')\n"
            " print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)\n",
        )
        mcp_path = tmp_path / "explicit-selected.config"
        mcp_path.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "valaris": {
                            "command": str(mcp_script),
                            "env": {
                                "FIXTURE_LOOP_URL": loop_url,
                                "FIXTURE_API_KEY": raw_key,
                            },
                        }
                    }
                }
            )
        )
        mcp_path.chmod(0o600)
        config_path = tmp_path / "runner.yaml"
        # JSON is valid YAML and avoids quoting shell fragments or secrets.
        config_path.write_text(
            json.dumps(
                {
                    "valaris": {
                        "api_url": api_url,
                        "api_key": raw_key,
                        "workspace_slug": "default",
                    },
                    "llm": {
                        "provider": "codex-cli",
                        "model": "fixture-review-model",
                        "mcp_config_path": str(mcp_path),
                        "max_budget_usd": 1,
                    },
                    "git": {"base_dir": str(tmp_path / "repos"), "forge": "gitea"},
                    "websocket": {"enabled": False},
                    "telemetry": {"enabled": False},
                }
            )
        )
        config_path.chmod(0o600)
        env = {
            "PATH": str(bin_dir) + ":/usr/bin:/bin",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }
        if scenario in {"interactive", "interactive-fresh"}:
            fresh_profile = scenario == "interactive-fresh"
            uvx = shutil.which("uvx")
            assert uvx, "the published-package TUI fixture needs uvx"
            first_use = tmp_path / "first-use"
            first_use.mkdir()
            config_home = tmp_path / "first-use-config"
            config_home.mkdir()
            metadata_dir = (
                Path(interactive_dir).resolve()
                if interactive_dir
                else tmp_path / "terminal"
            )
            metadata_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            metadata_dir.chmod(0o700)
            finish = metadata_dir / "finished"
            assert not finish.exists(), "use a fresh interactive fixture directory"
            interactive_env = {
                **env,
                "PATH": env["PATH"] + ":" + str(Path(uvx).parent),
                "XDG_CONFIG_HOME": str(config_home),
                "VALARIS_API_URL": api_url,
                "VALARIS_API_KEY": raw_key,
                "VALARIS_WORKSPACE": "default",
                "HOME": str(tmp_path / "home"),
                "UV_NO_CONFIG": "true",
                "UV_HTTP_TIMEOUT": "15",
                "UV_HTTP_RETRIES": "0",
                "UV_TOOL_DIR": str(tmp_path / "uv-tools"),
                "UV_PYTHON": sys.executable,
                "UV_PYTHON_INSTALL_DIR": str(tmp_path / "uv-python"),
                "UV_CACHE_DIR": os.environ.get(
                    "BACKPLANE_MCP_CACHE_DIR", str(tmp_path / "uv-cache")
                ),
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
            }
            # Populate one isolated resolver cache with both versions. The
            # generated recipe must still launch the qualified pin, not 0.7.3.
            for mcp_version in ("0.7.3", "0.8.0"):
                warm = await asyncio.create_subprocess_exec(
                    uvx,
                    "--from",
                    f"backplane-mcp=={mcp_version}",
                    "python",
                    "-c",
                    "from importlib.metadata import version; print(version('backplane-mcp'))",
                    env=interactive_env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    warm_stdout, _ = await asyncio.wait_for(warm.communicate(), 120)
                    assert (
                        warm.returncode == 0
                    ), "published MCP cache preparation failed"
                    assert warm_stdout.decode().strip() == mcp_version
                finally:
                    if warm.returncode is None:
                        warm.kill()
                        await warm.wait()
            profile_dir = config_home / "backplane" / "profiles" / "qualification"
            if not fresh_profile:
                profile_dir.mkdir(parents=True)
                profile_cfg = json.loads(config_path.read_text())
                profile_cfg["llm"]["mcp_config_path"] = ""
                profile_cfg["git"]["base_dir"] = str(tmp_path / "interactive-repos")
                (profile_dir / "runner.yaml").write_text(json.dumps(profile_cfg))
                (profile_dir / "credentials").write_text(
                    f"VALARIS_API_KEY={raw_key}\nVALARIS_API_URL={api_url}\nVALARIS_WORKSPACE=default\n"
                )
                (profile_dir / "credentials").chmod(0o600)
            terminal = OwnedTerminal(
                [str(artifact), "-interactive"],
                env=interactive_env,
                cwd=first_use,
                directory=metadata_dir,
            )
            await terminal.start()
            metadata = metadata_dir / "launch.json"
            with metadata.open("x") as file:
                json.dump(
                    {
                        "runner": str(artifact),
                        "argv": ["-interactive"],
                        "cwd": str(first_use),
                        "terminal_socket": terminal.socket_path,
                        "terminal_identity": terminal.nonce,
                        "workdir": str(tmp_path / "interactive-repos"),
                        "finish_file": str(finish),
                        "expected_sha": sha,
                        "review_sha_file": str(review_marker),
                        "artifact_sha256": digest,
                    },
                    file,
                )
            metadata.chmod(0o600)
            launcher = metadata_dir / "launch.py"
            launcher.write_text(
                "import runpy,sys\n"
                "from pathlib import Path\n"
                f"helper={str(Path(__file__).with_name('runner_fixture_terminal.py'))!r}\n"
                "sys.argv=[helper,'--relay',sys.argv[1]]\n"
                "runpy.run_path(helper,run_name='__main__')\n"
            )
            launcher.chmod(0o600)
            print(
                json.dumps(
                    {
                        "interactive_fixture_ready": str(metadata),
                        "launcher": str(launcher),
                    }
                ),
                flush=True,
            )
            if interactive_dir:
                async with asyncio.timeout(600):
                    while not finish.exists():
                        await asyncio.sleep(0.1)
            else:
                driver = TerminalDriver(terminal)
                try:
                    await driver.connect()
                    if fresh_profile:
                        await driver.expect("Which backend, and with which key?")
                        await driver.send("\r")
                        await driver.expect("These credentials are new")
                        await driver.send("e")
                        await driver.expect("Profile name:")
                        await driver.send("\x01\x0bqualification\r")
                    else:
                        await driver.expect("Which profile?")
                        await driver.send("\r")
                    await driver.expect("What should this runner do?")
                    await driver.send("\r")
                    await driver.expect("Which board?")
                    await driver.expect(str(f.board.name))
                    await driver.send("\r")
                    await driver.expect("Where should the runner work?")
                    # Fresh profiles use their default inside the fixture's
                    # isolated HOME; existing profiles retain their saved path.
                    await driver.send("\r")
                    await driver.expect("How should it run?")
                    # Choose Claude/Fable for this run. Existing profiles keep
                    # Codex; fresh profiles confirm it from board requirements.
                    await driver.send(" ")
                    await driver.expect("[Choose a model for this run]")
                    await driver.send(
                        ("\t\t" if fresh_profile else "\t\x1b[D\t") + "\x01\x0bfable\r"
                    )
                    await driver.expect("Write one for me")
                    await driver.send("\r")
                    await driver.expect("Ready to launch")
                    await driver.expect("codex-cli / fixture-review-model")
                    await driver.expect("Enter confirms these providers")
                    await driver.send("\r")
                    await asyncio.wait_for(receipt_received.wait(), 45)
                finally:
                    transcript = driver.transcript
                    for secret in (raw_key, WORKSPACE_TOKEN, PLATFORM_TOKEN):
                        transcript = transcript.replace(secret, "[fixture credential]")
                    (tmp_path / "terminal-transcript.txt").write_text(transcript)
                    await driver.close()
            await terminal.close()
            assert (
                receipt_received.is_set()
            ), "interactive run did not publish a completion receipt"
            assert review_marker.read_text() == sha
            assert not source_marker.exists()
            source_executions = (
                await f.db.scalars(
                    select(AgentExecution).where(
                        AgentExecution.board_id == f.board.id,
                        AgentExecution.action == "loop_iteration",
                    )
                )
            ).all()
            assert (
                len(source_executions) == 1
            ), "interactive run repeated preserved source work"
            generated = []
            for root in (first_use, config_home):
                for path in root.rglob("*.json"):
                    try:
                        server_config = json.loads(path.read_text())["mcpServers"][
                            "valaris"
                        ]
                    except (ValueError, KeyError, TypeError):
                        continue
                    if server_config.get("command") == "uvx":
                        generated.append(server_config)
            assert generated, "first-use wizard did not generate a uvx config"
            assert all(
                "backplane-mcp==0.8.0" in item.get("args", []) for item in generated
            )
            assert {auth for _, auth in forge_http.requests} == {
                f"Bearer {WORKSPACE_TOKEN}"
            }
            saved_profile = yaml.safe_load((profile_dir / "runner.yaml").read_text())
            selected_mcp = Path(saved_profile["llm"]["mcp_config_path"])
            assert selected_mcp.is_absolute() and selected_mcp.is_file()
            if fresh_profile:
                assert saved_profile["llm"]["provider"] == "claude-cli"
                assert "codex-cli" in saved_profile["llm"]["extra_providers"]
            else:
                assert saved_profile["llm"]["provider"] == "codex-cli"
            assert not saved_profile["llm"].get("run_override")
            elsewhere = tmp_path / "different-cwd"
            elsewhere.mkdir()
            wrong_marker = tmp_path / "wrong-mcp-invoked"
            wrong_mcp = elsewhere / "wrong-mcp"
            write_executable(
                wrong_mcp,
                "#!/bin/sh\ntouch " + shlex.quote(str(wrong_marker)) + "\nexit 71\n",
            )
            (elsewhere / "mcp-config.json").write_text(
                json.dumps({"mcpServers": {"valaris": {"command": str(wrong_mcp)}}})
            )

            async def saved_profile_doctor():
                child = await asyncio.create_subprocess_exec(
                    str(artifact),
                    "-profile",
                    "qualification",
                    "-doctor",
                    "-loop-board",
                    str(f.board.id),
                    "-run-provider",
                    "claude-cli",
                    "-run-model",
                    "fable",
                    cwd=elsewhere,
                    env=interactive_env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                try:
                    captured, _ = await asyncio.wait_for(child.communicate(), 45)
                    return child.returncode, captured.decode()
                finally:
                    if child.returncode is None:
                        child.kill()
                        await child.wait()

            doctor_code, doctor_output = await saved_profile_doctor()
            assert (
                doctor_code == 0
            ), "saved profile failed from a different working directory"
            # The terminal report wraps long absolute paths. The exact saved path
            # is asserted above; a successful probe plus the untouched conflicting
            # config marker proves this invocation used that explicit selection.
            assert "0.8.0" in doctor_output
            assert not wrong_marker.exists()
            selected_mcp.unlink()
            missing_code, missing_output = await saved_profile_doctor()
            assert (
                missing_code != 0
            ), "missing explicit MCP config unexpectedly passed doctor"
            assert (
                not wrong_marker.exists()
            ), "missing selected config silently fell back to cwd"
            for secret in (raw_key, WORKSPACE_TOKEN, PLATFORM_TOKEN):
                assert secret not in doctor_output + missing_output
            print(
                json.dumps(
                    {
                        "scenario": scenario,
                        "result": "passed",
                        "artifact_sha256": digest,
                        "source_sha": sha,
                        "published_mcp": "0.8.0",
                        "model_service_calls": 0,
                    }
                ),
                flush=True,
            )
            return

        async def run_once(*, parked=False, rejected=False):
            nonlocal process
            receipt_received.clear()
            work_read.clear()
            process = await asyncio.create_subprocess_exec(
                str(artifact),
                "-config",
                str(config_path),
                "-loop",
                "-loop-board",
                str(f.board.id),
                "-run-provider",
                "claude-cli",
                "-run-model",
                "fable",
                cwd=tmp_path,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            capture = asyncio.create_task(process.communicate())
            if parked:
                await asyncio.wait_for(work_read.wait(), 20)
                # Wait for the completed work response to be handled before
                # stopping this fresh process; no result or vendor is allowed.
                await asyncio.sleep(0.2)
                process.send_signal(signal.SIGTERM)
                stdout, _ = await asyncio.wait_for(capture, 5)
            elif scenario in {"pr-denied", "missing-runtime", "budget-history"}:
                stdout, _ = await asyncio.wait_for(capture, 20)
            else:
                completed = asyncio.create_task(receipt_received.wait())
                done, _ = await asyncio.wait(
                    {capture, completed},
                    timeout=20,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if completed not in done:
                    completed.cancel()
                    if process.returncode is None:
                        process.send_signal(signal.SIGTERM)
                    stdout, _ = await asyncio.wait_for(capture, 5)
                    pytest.fail(
                        "runner did not publish a real accepted completion receipt:\n"
                        + stdout.decode()
                    )
                if not rejected and process.returncode is None:
                    process.send_signal(signal.SIGTERM)
                stdout, _ = await asyncio.wait_for(capture, 5)
            return stdout

        stdout = await run_once(rejected=scenario == "recovery")

        output = stdout.decode()
        for secret in (WORKSPACE_TOKEN, PLATFORM_TOKEN, RAW_ERROR, raw_key):
            assert secret not in output
        assert (
            not source_marker.exists()
        ), "preserved candidate caused repeated source implementation"
        if scenario != "missing-runtime":
            assert forge_http.requests
        assert {auth for _, auth in forge_http.requests} <= {
            f"Bearer {WORKSPACE_TOKEN}"
        }
        attempts = (await f.db.scalars(select(CompletionAttempt))).all()
        if scenario == "recovery":
            assert len(attempts) == 1 and attempts[0].status == "rejected"
            assert attempts[0].candidate_id == candidate.id
            assert "explicitly retry completion" in output
            assert result_receipts[0]["status"] == "rejected"
            assert result_receipts[0]["code"] == "completion_context_changed"
            assert result_receipts[0]["retryable"] is True
            assert result_receipts[0]["next_action"] == "retry_completion"
            assert result_receipts[0]["changed_sources"]
            await f.db.refresh(candidate)
            assert candidate.status == "failed"
            previous_requests = len(requests)
            review_marker.unlink()
            stdout += await run_once(parked=True)
            assert not review_marker.exists() and not source_marker.exists()
            assert not any(
                path.endswith("/claim") for _, path in requests[previous_requests:]
            )
            retry = await client.post(f"{f.url}/cards/{f.card.id}/retry")
            assert retry.status_code == 200, retry.text
            await f.db.commit()
            stdout += await run_once()
            attempts = (await f.db.scalars(select(CompletionAttempt))).all()
            assert len(attempts) == 2
            assert {attempt.status for attempt in attempts} == {"rejected", "passed"}
            assert all(attempt.candidate_id == candidate.id for attempt in attempts)
            assert review_marker.read_text() == sha and not source_marker.exists()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
                headers={"Authorization": "Bearer " + raw_key},
            ) as artifact_client:
                replay = await artifact_client.post(
                    first_result[0], json=first_result[1]
                )
            assert replay.status_code == 200
            assert replay.json()["result_receipt"] == result_receipts[0]
            assert replay.json()["candidate"]["id"] == saved["id"]
            assert replay.json()["candidate"]["review_passed"] is True
            assert len((await f.db.scalars(select(CompletionAttempt))).all()) == 2
        elif scenario in {"pr-denied", "missing-runtime", "budget-history"}:
            assert process.returncode not in (None, 0)
            assert attempts == []
            assert not review_marker.exists() and not check_marker.exists()
            if scenario == "pr-denied":
                assert "pull_requests_read" in output
                assert "deployed workspace connection credential" in output
                assert "permissions before launching" in output
            elif scenario == "missing-runtime":
                assert "codex-code-mode-host" in output
                assert "runtime" in output
            else:
                assert "history" in output.lower() and "budget" in output.lower()
            assert not any(path.endswith("/claim") for _, path in requests)
        else:
            assert len(attempts) == 1
            attempt = attempts[0]
            expected_sha = merge_sha if scenario == "validation" else sha
            assert attempt.candidate_id == candidate.id
            assert attempt.source_sha == expected_sha
            assert attempt.result["outcome"] == "passed", attempt.result.get("summary")
            assert attempt.result["source_sha"] == expected_sha
            assert attempt.result["candidate_id"] == saved["id"]
            if scenario == "review":
                assert review_marker.read_text() == sha
                argv = json.loads(review_args.read_text())
                for secret in (WORKSPACE_TOKEN, PLATFORM_TOKEN, raw_key):
                    assert secret not in str(argv)
                assert "fixture-review-model" in argv
                assert "fable" not in argv
                assert not check_marker.exists()
            else:
                assert (
                    attempt.source_sha != sha
                ), "validation must qualify a distinct landed revision"
                assert check_marker.read_text() == merge_sha
                assert not review_marker.exists()
                assert attempt.result["checks"][0]["source_sha"] == merge_sha
                assert attempt.result["checks"][0]["exit_code"] == 0
        print(
            json.dumps(
                {
                    "scenario": scenario,
                    "result": "passed",
                    "artifact_sha256": digest,
                    "source_sha": sha,
                    "merge_sha": merge_sha,
                    "later_main_sha": later_sha,
                    "model_service_calls": 0,
                }
            )
        )
    finally:
        try:
            if terminal is not None:
                await terminal.close()
        finally:
            try:
                if process is not None and process.returncode is None:
                    process.kill()
                    await process.wait()
            finally:
                server.should_exit = True
                try:
                    await asyncio.wait_for(server_task, 5)
                finally:
                    sock.close()
