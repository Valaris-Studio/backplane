# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Explicit opt-in fixture driver: real ClaudeCLI, never a canned completion."""

import asyncio
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


async def command(*args, cwd=None, env=None, timeout=240):
    process = await asyncio.create_subprocess_exec(
        *args, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
        return process.returncode, output.decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def run_live_continuation(
    *, http, auth, response, stage, note, workspace, agent_id, url,
    agent_key, rendered, prompt, alias, excluded, tmp_path,
):
    seed = Path(os.environ["CONTINUATION_SEED_REPO"])
    output = Path(os.environ["CONTINUATION_LIVE_OUT"])
    output.mkdir(parents=True, exist_ok=True)
    repo = tmp_path / "recipient-booking"
    status, log = await command("git", "clone", "--no-hardlinks", str(seed), str(repo))
    assert status == 0, log
    status, seed_sha = await command("git", "rev-parse", "HEAD", cwd=repo)
    assert status == 0, seed_sha
    frozen_tests = (repo / "test_booking_contract.py").read_bytes()
    before, before_log = await command(sys.executable, "-m", "unittest", "-v", cwd=repo)
    (output / "booking-before.log").write_text(before_log)
    assert before != 0 and "failures=3" in before_log, before_log
    authored_prompt = (
        prompt + "\nShared note identity: " + note["id"] + ".\n"
        "Implement the reviewed requirement in booking_server.py only. "
        "Do not modify test_booking_contract.py, README.md or any other file. "
        "Keep the lock and existing HTTP API. Run python3 -m unittest -v. "
        "Do not commit, push, use network tools, read environment variables, or access "
        "other directories. Do not fetch private captured sources. "
        "Return the actual change and test results, citing the shared note identity."
    )
    configured = await http.post(
        f"/api/workspaces/{workspace}/prompt-configs", headers=auth("curator"),
        json={"name": "Synthetic continuation", "slug": "continue-booking",
              "team_role": stage["role"], "stage": stage["llm"]["stage"],
              "content": authored_prompt},
    )
    assert configured.status_code == 201, configured.text
    prompt_config = configured.json()
    assert not prompt_config["context_source_warnings"], prompt_config
    packet = {
        "assignment": response, "workspace_slug": workspace, "agent_id": agent_id,
        "alias": alias, "expected_context": rendered, "excluded_markers": excluded,
        "note_id": note["id"], "prompt_config_id": prompt_config["id"],
        "prompt_config_version": prompt_config["version"],
        "fixture_prompt_ceiling_bytes": 32768, "repo": str(repo),
        "seed_sha": seed_sha.strip(),
    }
    (output / "packet.json").write_text(json.dumps(packet, indent=2) + "\n")
    mcp_template = tmp_path / "fixture-mcp.json"
    mcp_template.write_text(json.dumps({"mcpServers": {"valaris": {
        "command": os.environ["CONTINUATION_MCP_PYTHON"],
        "args": ["-c", "from valaris_mcp.server import main; main()"],
        "env": {"VALARIS_API_URL": url, "VALARIS_API_KEY": agent_key},
    }}}))
    mcp_template.chmod(0o600)
    env = {key: os.environ[key] for key in (
        "HOME", "PATH", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL",
    ) if key in os.environ}
    env.update({
        "RUN_LIVE_CONTINUATION": "1", "CONTINUATION_LIVE_URL": url,
        "CONTINUATION_AGENT_KEY": agent_key, "CONTINUATION_LIVE_OUT": str(output),
        "CONTINUATION_MCP_TEMPLATE": str(mcp_template),
    })
    try:
        status, native_log = await command(
            os.environ["CONTINUATION_LIVE_GO_BIN"],
            "-test.run=^TestReviewedHandoffLiveClaudeContinuation$", "-test.v", "-test.timeout=240s",
            env=env, timeout=250,
        )
    finally:
        mcp_template.unlink(missing_ok=True)
    (output / "runner-live.log").write_text(native_log)
    assert status == 0, native_log
    provider = json.loads((output / "provider.json").read_text())
    assert provider["exit_code"] == 0 and provider["session_id"]
    assert note["id"] in provider["output"], provider["output"]
    status, current_sha = await command("git", "rev-parse", "HEAD", cwd=repo)
    assert status == 0 and current_sha == seed_sha, "Provider must not commit fixture changes"
    assert (repo / "test_booking_contract.py").read_bytes() == frozen_tests
    after, after_log = await command(sys.executable, "-m", "unittest", "-v", cwd=repo)
    (output / "booking-after.log").write_text(after_log)
    status, changed = await command("git", "diff", "HEAD", "--name-only", cwd=repo)
    assert status == 0 and changed.splitlines() == ["booking_server.py"], changed
    status, untracked = await command("git", "ls-files", "--others", "--exclude-standard", cwd=repo)
    assert status == 0 and not untracked.strip(), untracked
    status, diff = await command("git", "diff", "HEAD", "--", "booking_server.py", cwd=repo)
    assert status == 0, diff
    (output / "booking-change.patch").write_text(diff)
    shutil.copyfile(repo / "booking_server.py", output / "booking_server.py")
    executions = await http.get(f"/api/agents/{agent_id}/executions", headers=auth("recipient_agent"))
    assert executions.status_code == 200, executions.text
    execution = next(row for row in executions.json() if row["id"] == provider["execution_id"])
    assert execution["input_prompt"] == provider["prompt"]
    assert after == 0, after_log
    completed = await http.patch(
        f"/api/agents/{agent_id}/executions/{provider['execution_id']}",
        headers=auth("recipient_agent"), json={
            "status": "completed", "output_summary": "Independent frozen booking oracle: 6 passed",
        },
    )
    assert completed.status_code == 200, completed.text
    (output / "completion.json").write_text(json.dumps({
        "evidence_kind": "synthetic-ingest-real-http-real-ClaudeCLI-independent-application-tests",
        "seed_sha": seed_sha.strip(), "independent_tests_sha256": hashlib.sha256(frozen_tests).hexdigest(),
        "independent_tests_unchanged": True, "before": "3 failed, 3 passed", "after": "6 passed",
        "provider_session_id": provider["session_id"], "execution_id": provider["execution_id"],
        "note_id": note["id"], "prompt_config_id": prompt_config["id"],
        "stored_prompt_equals_dispatched": True, "changed_files": changed.splitlines(),
        "limits": ["synthetic API ingest, not local Companion capture or browser publication",
                   "explicit operator-authored note identity; no automatic normal-packet manifest",
                   "32KiB is fixture ceiling, not platform policy", "no production loop or forge"],
    }, indent=2) + "\n")
