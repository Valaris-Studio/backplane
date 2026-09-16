# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the real MergeExecutor (PAR-3).

The executor wraps git + gh subprocesses behind a `GitOps` Protocol so tests
mock at that boundary instead of stubbing subprocess. Cases covered:

  - clean rebase + push + gh-merge -> ('merged', timestamp)
  - rebase conflict -> ('conflict', message-with-files)
  - push failure   -> ('failed', wrapped error)
  - gh merge failure -> ('failed', wrapped error)
  - clone failure   -> ('failed', wrapped error)
"""

from __future__ import annotations

import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import List

import pytest

from app.models.agents.merge_queue import MergeQueueEntry
from app.services.merge_executor import (
    GitOpsError,
    MergeExecutor,
    make_merge_executor,
    RebaseConflict,
    RebaseResult,
    SubprocessGitOps,
    _redact_url_credentials,
    _rewrite_url_with_token,
    _userinfo_username_for_provider,
)


def _entry(
    *,
    pr_url: str = "https://github.com/acme/acme/pull/7",
    pr_branch: str = "feat/widget",
    integration_branch: str = "develop",
) -> MergeQueueEntry:
    return MergeQueueEntry(
        id=uuid.uuid4(),
        repo_id=uuid.uuid4(),
        integration_branch=integration_branch,
        card_id=uuid.uuid4(),
        pr_url=pr_url,
        pr_branch=pr_branch,
        workspace_id=uuid.uuid4(),
        state="merging",
        attempt_count=1,
    )


class _FakeGitOps:
    """Records call sequence + drives outcomes from canned responses."""

    def __init__(
        self,
        *,
        rebase_result: RebaseResult | None = None,
        clone_error: Exception | None = None,
        push_error: Exception | None = None,
        merge_pr_error: Exception | None = None,
        rebase_error: Exception | None = None,
    ) -> None:
        self.rebase_result = rebase_result or RebaseResult(success=True)
        self.clone_error = clone_error
        self.push_error = push_error
        self.merge_pr_error = merge_pr_error
        self.rebase_error = rebase_error
        self.calls: List[tuple[str, dict]] = []

    async def clone(self, *, repo_url: str, branch: str, workdir: Path, env=None) -> None:
        self.calls.append(("clone", {"repo_url": repo_url, "branch": branch}))
        if self.clone_error is not None:
            raise self.clone_error

    async def fetch_branch(self, *, workdir: Path, branch: str, env=None) -> None:
        self.calls.append(("fetch_branch", {"branch": branch}))

    async def checkout(self, *, workdir: Path, branch: str, env=None) -> None:
        self.calls.append(("checkout", {"branch": branch}))

    async def rebase(self, *, workdir: Path, onto: str, env=None) -> RebaseResult:
        self.calls.append(("rebase", {"onto": onto}))
        if self.rebase_error is not None:
            raise self.rebase_error
        return self.rebase_result

    async def push_force_with_lease(self, *, workdir: Path, branch: str, env=None) -> None:
        self.calls.append(("push", {"branch": branch}))
        if self.push_error is not None:
            raise self.push_error

    async def merge_pr(
        self,
        *,
        workdir: Path,
        pr_url: str,
        forge: str = "github",
        integration_branch: str = "",
        pr_branch: str = "",
        env=None,
    ) -> None:
        self.calls.append(("merge_pr", {"pr_url": pr_url, "forge": forge}))
        if self.merge_pr_error is not None:
            raise self.merge_pr_error


async def _resolve_repo_url(_entry: MergeQueueEntry) -> str:
    return "https://github.com/acme/acme.git"


@pytest.mark.asyncio
async def test_executor_clean_path_returns_merged():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    entry = _entry()
    outcome = await executor(entry)

    assert outcome[0] == "merged"
    assert isinstance(outcome[1], datetime)

    op_names = [c[0] for c in git_ops.calls]
    assert op_names == [
        "clone",
        "fetch_branch",
        "checkout",
        "rebase",
        "push",
        "merge_pr",
    ]
    assert git_ops.calls[0][1]["branch"] == "develop"
    assert git_ops.calls[1][1]["branch"] == "feat/widget"
    assert git_ops.calls[3][1]["onto"] == "develop"
    assert git_ops.calls[4][1]["branch"] == "feat/widget"


@pytest.mark.asyncio
async def test_executor_rebase_conflict_returns_conflict_with_files():
    git_ops = _FakeGitOps(
        rebase_result=RebaseResult(
            success=False,
            conflict=RebaseConflict(
                files=["app/foo.py", "app/bar.py"],
                stderr="CONFLICT (content): Merge conflict in app/foo.py",
            ),
        )
    )
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    outcome = await executor(_entry())

    assert outcome[0] == "conflict"
    message = outcome[1]
    assert "app/foo.py" in message
    assert "app/bar.py" in message
    # push + merge_pr must NOT have been called once we hit conflict.
    op_names = [c[0] for c in git_ops.calls]
    assert "push" not in op_names
    assert "merge_pr" not in op_names


@pytest.mark.asyncio
async def test_executor_push_failure_returns_failed():
    git_ops = _FakeGitOps(push_error=GitOpsError("non-fast-forward, ref locked"))
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "ref locked" in outcome[1]
    op_names = [c[0] for c in git_ops.calls]
    assert "merge_pr" not in op_names


@pytest.mark.asyncio
async def test_executor_gh_merge_failure_returns_failed():
    git_ops = _FakeGitOps(merge_pr_error=GitOpsError("gh: PR is not approved"))
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "PR is not approved" in outcome[1]


@pytest.mark.asyncio
async def test_executor_clone_failure_returns_failed():
    git_ops = _FakeGitOps(clone_error=GitOpsError("repo not found"))
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "repo not found" in outcome[1]
    # We bail before any further git op.
    assert [c[0] for c in git_ops.calls] == ["clone"]


@pytest.mark.asyncio
async def test_executor_unexpected_rebase_exception_returns_failed():
    git_ops = _FakeGitOps(rebase_error=RuntimeError("git crashed"))
    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_repo_url)

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "git crashed" in outcome[1]


# ---------------------------------------------------------------------------
# URL token rewrite (PAR-3-wiring)
# ---------------------------------------------------------------------------


def test_rewrite_https_url_with_token_embeds_token_for_github():
    rewritten = _rewrite_url_with_token(
        "https://github.com/acme/widgets.git", "ghp_TOKEN"
    )
    assert rewritten == ("https://x-access-token:ghp_TOKEN@github.com/acme/widgets.git")


def test_rewrite_https_url_defaults_to_github_x_access_token_username():
    # Default username keeps the byte-identical GitHub form so the prod path
    # is unchanged when the caller doesn't pass a provider-specific username.
    rewritten = _rewrite_url_with_token(
        "https://github.com/acme/widgets.git", "ghp_TOKEN"
    )
    assert rewritten.startswith("https://x-access-token:")


def test_rewrite_https_url_with_token_uses_oauth2_username_for_gitlab():
    # GitLab requires the magic `oauth2` username for token-over-HTTPS push;
    # `x-access-token` is GitHub-only. Caller passes the provider's username.
    rewritten = _rewrite_url_with_token(
        "https://gitlab.com/acme/widgets.git", "glpat_TOKEN", username="oauth2"
    )
    assert rewritten == ("https://oauth2:glpat_TOKEN@gitlab.com/acme/widgets.git")


def test_rewrite_https_url_with_token_uses_oauth2_username_for_gitea():
    # Gitea/Forgejo accept `oauth2:<token>@` (token as password, magic
    # username) — the robust form when the bot has no per-repo Gitea username.
    rewritten = _rewrite_url_with_token(
        "https://gitea.example.com/acme/widgets.git", "gta_TOKEN", username="oauth2"
    )
    assert rewritten == ("https://oauth2:gta_TOKEN@gitea.example.com/acme/widgets.git")


def test_rewrite_url_with_token_returns_ssh_url_unchanged():
    ssh_url = "git@github.com:acme/widgets.git"
    assert _rewrite_url_with_token(ssh_url, "ghp_TOKEN") == ssh_url


def test_rewrite_url_with_empty_token_returns_input_unchanged():
    https_url = "https://github.com/acme/widgets.git"
    assert _rewrite_url_with_token(https_url, "") == https_url


def test_rewrite_url_with_token_does_not_double_embed_existing_credentials():
    # If the URL already carries credentials we must not stack a second pair —
    # and the userinfo (username included) is fully replaced, not appended.
    pre_authed = "https://oauth2:OLD@gitlab.com/acme/widgets.git"
    rewritten = _rewrite_url_with_token(pre_authed, "NEW", username="oauth2")
    assert rewritten == "https://oauth2:NEW@gitlab.com/acme/widgets.git"


# ---------------------------------------------------------------------------
# Provider -> userinfo-username + per-provider token selection (clone-auth)
# ---------------------------------------------------------------------------


def test_userinfo_username_for_provider_github_is_x_access_token():
    assert _userinfo_username_for_provider("github") == "x-access-token"


@pytest.mark.parametrize("provider", ["gitlab", "gitea", "bitbucket", "other"])
def test_userinfo_username_for_provider_nongithub_is_oauth2(provider):
    # Every non-github host uses the magic `oauth2` username (token as
    # password) — the GitLab-documented and Gitea-accepted universal form.
    assert _userinfo_username_for_provider(provider) == "oauth2"


def test_userinfo_username_for_provider_unknown_defaults_to_oauth2():
    # A provider the backend doesn't know is treated as a generic non-github
    # host, not silently given GitHub's form.
    assert _userinfo_username_for_provider("madeup") == "oauth2"


def test_merge_executor_has_no_second_token_resolution_path():
    """Token selection moved WHOLESALE to CredentialResolver — this module must
    not grow a parallel one back.

    The deleted `_token_for_provider` fell back to GITHUB_TOKEN for every
    non-github provider, which embedded the platform's GitHub PAT into
    gitlab/gitea clone URLs. Per-provider selection and the closed
    cross-provider hole are pinned in tests/services/git/test_credential_resolver.py
    and tests/services/test_merge_executor_credential_wiring.py.
    """
    from app.services import merge_executor as mod

    assert not hasattr(mod, "_token_for_provider")


# ---------------------------------------------------------------------------
# SubprocessGitOps env + identity wiring (PAR-3-wiring)
# ---------------------------------------------------------------------------


class _FakeProcess:
    def __init__(
        self, *, returncode: int = 0, stdout: bytes = b"", stderr: bytes = b""
    ):
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr


@pytest.mark.asyncio
async def test_subprocess_git_ops_passes_env_overrides_to_subprocess(monkeypatch):
    captured: dict = {}

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        captured["cmd"] = cmd
        captured["env"] = env
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps(
        env_overrides={"GH_TOKEN": "ghp_secret"},
    )
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="main")

    assert captured["env"] is not None
    assert captured["env"]["GH_TOKEN"] == "ghp_secret"
    # PATH (and other parent env) must still be present so child can find git.
    assert "PATH" in captured["env"]


@pytest.mark.asyncio
async def test_subprocess_git_ops_pins_git_allow_protocol(monkeypatch):
    """Remote-helper protocols (`ext::`, `fd::`) must be unreachable at the exec
    edge, not just rejected by the schema validators. `ext::sh -c …` is a live
    RCE; pinning the allowlist means a future ingress that skips validation
    still can't reach it."""
    captured: dict = {}

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        captured["env"] = env
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps()
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="main")

    allowed = captured["env"]["GIT_ALLOW_PROTOCOL"].split(":")
    assert set(allowed) == {"https", "http", "ssh", "git"}
    assert "ext" not in allowed
    assert "fd" not in allowed


@pytest.mark.asyncio
async def test_subprocess_git_ops_git_allow_protocol_survives_ambient_env(monkeypatch):
    """A permissive `GIT_ALLOW_PROTOCOL` inherited from the worker's own
    environment must not widen what the child git may do."""
    captured: dict = {}

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        captured["env"] = env
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "ext:fd:https")

    ops = SubprocessGitOps()
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="main")

    assert "ext" not in captured["env"]["GIT_ALLOW_PROTOCOL"].split(":")


@pytest.mark.asyncio
async def test_subprocess_git_ops_env_overrides_cannot_widen_git_allow_protocol(
    monkeypatch,
):
    """`env_overrides` carries caller-supplied values (tokens today, more
    later). It must not be a back door onto the protocol allowlist."""
    captured: dict = {}

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        captured["env"] = env
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps(env_overrides={"GIT_ALLOW_PROTOCOL": "ext:fd"})
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="main")

    assert "ext" not in captured["env"]["GIT_ALLOW_PROTOCOL"].split(":")


@pytest.mark.slow
@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")
async def test_subprocess_git_ops_live_ext_url_blocked_despite_permissive_ambient_env(
    tmp_path, monkeypatch
):
    """The acceptance check, run against real `git`.

    Modern git already refuses `ext::` by default, so the pin only earns its
    keep in the case that defeats the default: an ambient
    `GIT_ALLOW_PROTOCOL` that re-enables the remote-helper class. Without the
    pin this clone executes `touch <canary>` as a live RCE; with it, git dies
    on its own protocol gate.
    """
    canary = tmp_path / "pwned"
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "ext:https")
    ops = SubprocessGitOps()

    with pytest.raises(GitOpsError) as excinfo:
        await ops.clone(
            repo_url=f"ext::sh -c touch% {canary}",
            branch="main",
            workdir=tmp_path / "clone",
        )

    assert "transport" in str(excinfo.value).lower()
    assert not canary.exists()


@pytest.mark.asyncio
async def test_subprocess_git_ops_uses_git_identity_flags_on_rebase(monkeypatch):
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        # Rebase calls _run_capture and inspects rc; return success.
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps(
        git_identity=("Backplane Merge Bot", "merge-bot@valaris.studio"),
    )
    await ops.rebase(workdir=Path("/tmp/x"), onto="develop")

    rebase_cmd = seen_commands[0]
    assert "git" == rebase_cmd[0]
    assert "-c" in rebase_cmd
    joined = " ".join(rebase_cmd)
    assert "user.name=Backplane Merge Bot" in joined
    assert "user.email=merge-bot@valaris.studio" in joined
    assert "rebase" in rebase_cmd


@pytest.mark.asyncio
async def test_subprocess_git_ops_uses_git_identity_flags_on_push(monkeypatch):
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps(
        git_identity=("Backplane Merge Bot", "merge-bot@valaris.studio"),
    )
    await ops.push_force_with_lease(workdir=Path("/tmp/x"), branch="feat/x")

    push_cmd = seen_commands[0]
    joined = " ".join(push_cmd)
    assert "user.name=Backplane Merge Bot" in joined
    assert "user.email=merge-bot@valaris.studio" in joined
    assert "push" in push_cmd


@pytest.mark.asyncio
async def test_subprocess_git_ops_omits_identity_flags_on_clone(monkeypatch):
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps(
        git_identity=("Backplane Merge Bot", "merge-bot@valaris.studio"),
    )
    await ops.clone(
        repo_url="https://github.com/acme/widgets.git",
        branch="develop",
        workdir=Path("/tmp/x"),
    )
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="feat/x")
    await ops.checkout(workdir=Path("/tmp/x"), branch="feat/x")

    # Clone/fetch/checkout don't author commits so identity flags are noise.
    for cmd in seen_commands:
        joined = " ".join(cmd)
        assert "user.name=" not in joined
        assert "user.email=" not in joined


# ---------------------------------------------------------------------------
# Token redaction in error messages (PAR-3-wiring)
# ---------------------------------------------------------------------------


def test_redact_url_credentials_strips_userinfo_from_https_url():
    redacted = _redact_url_credentials(
        "https://x-access-token:ghp_SECRET@github.com/acme/widgets.git"
    )
    assert "ghp_SECRET" not in redacted
    assert redacted == "https://***@github.com/acme/widgets.git"


def test_redact_url_credentials_passes_clean_url_through():
    clean = "https://github.com/acme/widgets.git"
    assert _redact_url_credentials(clean) == clean


def test_redact_url_credentials_passes_non_url_text_through():
    msg = "fatal: could not read from remote repository"
    assert _redact_url_credentials(msg) == msg


@pytest.mark.asyncio
async def test_subprocess_git_ops_clone_failure_does_not_leak_token(monkeypatch):
    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        return _FakeProcess(
            returncode=128,
            stderr=b"fatal: Authentication failed for "
            b"'https://x-access-token:ghp_SECRET@github.com/acme/widgets.git/'",
        )

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps()
    with pytest.raises(GitOpsError) as exc_info:
        await ops.clone(
            repo_url=("https://x-access-token:ghp_SECRET@github.com/acme/widgets.git"),
            branch="develop",
            workdir=Path("/tmp/x"),
        )
    assert "ghp_SECRET" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_subprocess_git_ops_separates_refs_from_options(monkeypatch):
    """A `-`-leading url/branch must land after `--`, not be parsed as a git option.

    Without the separator, `git clone --upload-pack=cmd <dir>` runs `cmd` on this
    host — the same argument-injection class as the `ext::` transport RCE.
    """
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps()
    await ops.clone(
        repo_url="https://github.com/acme/widgets.git",
        branch="develop",
        workdir=Path("/tmp/x"),
    )
    await ops.fetch_branch(workdir=Path("/tmp/x"), branch="feat/x")
    await ops.checkout(workdir=Path("/tmp/x"), branch="feat/x")

    clone_cmd, fetch_cmd, checkout_cmd = seen_commands

    assert "--" in clone_cmd
    assert clone_cmd.index("--") < clone_cmd.index(
        "https://github.com/acme/widgets.git"
    )

    assert "--" in fetch_cmd
    assert fetch_cmd.index("--") < fetch_cmd.index("feat/x")

    # `checkout` gets no separator on purpose: after `--` git reads the
    # start-point as a pathspec and the checkout fails. Its operands are
    # option-safe already — `-B` consumes the branch, start-point is
    # `origin/`-prefixed.
    assert "--" not in checkout_cmd
    assert checkout_cmd.index("-B") < checkout_cmd.index("feat/x")
    assert "origin/feat/x" in checkout_cmd


@pytest.mark.asyncio
async def test_subprocess_git_ops_separates_branch_on_push(monkeypatch):
    """`git push --receive-pack=cmd` makes git spawn `/bin/sh -c cmd` — verified
    against real git. The branch must land after `--`."""
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps()
    await ops.push_force_with_lease(workdir=Path("/tmp/x"), branch="feat/x")

    push_cmd = seen_commands[0]
    assert "--" in push_cmd
    assert push_cmd.index("--") < push_cmd.index("feat/x")


@pytest.mark.asyncio
async def test_subprocess_git_ops_separates_branches_on_plain_git_merge(monkeypatch):
    """Non-github merge path: checkout/merge/push all take caller-supplied branches."""
    seen_commands: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen_commands.append(cmd)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _fake_create)

    ops = SubprocessGitOps()
    await ops.merge_pr(
        workdir=Path("/tmp/x"),
        pr_url="https://gitea.example/a/b/pulls/1",
        forge="gitea",
        integration_branch="main",
        pr_branch="feat/x",
    )

    checkout_cmd, merge_cmd, push_cmd = seen_commands

    # checkout can't take `--` (the ref would become a pathspec) — the schema's
    # branch validator is its guard. merge and push must have the separator.
    assert "--" not in checkout_cmd
    assert merge_cmd.index("--") < merge_cmd.index("feat/x")
    assert push_cmd.index("--") < push_cmd.index("main")


# --- require_ci_green (card 51810501) ---------------------------------------
#
# check_ci is an injected collaborator (None = skip, preserving historical
# behavior and every pre-existing test above by construction). It runs FIRST,
# before the clone — a pending CI must not cost a full clone per 10s tick.
# The verdict validates the PRE-rebase head; the post-rebase commit re-runs CI
# after the force-push and the human-visible PR reflects it.


def _ci_returning(state: str):
    calls: list = []

    async def check_ci(entry: MergeQueueEntry) -> str:
        calls.append(entry.pr_url)
        return state

    check_ci.calls = calls  # type: ignore[attr-defined]
    return check_ci


@pytest.mark.asyncio
async def test_executor_ci_green_proceeds_to_merge():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("green"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "merged"


@pytest.mark.asyncio
async def test_executor_ci_red_blocks_without_touching_git():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("red"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert "red" in outcome[1]
    assert git_ops.calls == [], "a red CI must not clone, push, or merge anything"


@pytest.mark.asyncio
async def test_executor_ci_pending_blocks_retryably():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("pending"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert "pending" in outcome[1]
    assert git_ops.calls == []


@pytest.mark.asyncio
async def test_executor_ci_none_fails_open_by_default():
    """A repo with no CI configured merges as before — require_ci_present
    defaults False (per the b2935b83 design)."""
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("none"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "merged"


@pytest.mark.asyncio
async def test_executor_ci_none_blocks_when_require_ci_present():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("none"),
        require_ci_present=True,
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert git_ops.calls == []


@pytest.mark.asyncio
async def test_executor_ci_read_failure_blocks_and_retries_never_merges():
    """Deliberate inversion of the house soft-pass: a merge gate that cannot
    READ the checks must block-and-retry, not merge on a guess."""

    async def broken_check(_entry: MergeQueueEntry) -> str:
        raise RuntimeError("github checks api down")

    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=broken_check,
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green", (
        "an unreadable CI state must be retryable ci_not_green, never merged "
        "and never terminal failed"
    )
    assert git_ops.calls == []


# --- per-board merge_gate (forge-CI opt-out) ---------------------------------
#
# resolve_merge_gate is an injected collaborator resolving the entry's board
# policy: "none" skips the CI gate entirely (GitHub Actions is optional, never
# a hard dependency), anything else — including no resolver, a resolver that
# raises, or an unrecognized value — fails closed to the existing forge_ci
# behavior.


def _gate_resolver(value: str):
    async def resolve_merge_gate(_entry: MergeQueueEntry) -> str:
        return value

    return resolve_merge_gate


@pytest.mark.asyncio
async def test_executor_merge_gate_none_skips_ci_check_entirely():
    ci_calls: list = []

    async def check_ci(entry: MergeQueueEntry) -> str:
        ci_calls.append(entry.pr_url)
        return "pending"  # would block if consulted

    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=check_ci,
        resolve_merge_gate=_gate_resolver("none"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "merged"
    assert ci_calls == [], (
        "merge_gate='none' must skip the CI check entirely, never await it "
        "and ignore the verdict"
    )


@pytest.mark.asyncio
async def test_executor_merge_gate_forge_ci_still_checks_ci():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("pending"),
        resolve_merge_gate=_gate_resolver("forge_ci"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert git_ops.calls == []


@pytest.mark.asyncio
async def test_executor_merge_gate_resolver_failure_fails_closed_to_ci_check():
    async def broken_resolver(_entry: MergeQueueEntry) -> str:
        raise RuntimeError("board lookup failed")

    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("pending"),
        resolve_merge_gate=broken_resolver,
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green", (
        "an unreadable board policy must fall back to checking CI, never "
        "skip the gate"
    )
    assert git_ops.calls == []


@pytest.mark.asyncio
async def test_executor_merge_gate_unrecognized_value_fails_closed_to_ci_check():
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("pending"),
        resolve_merge_gate=_gate_resolver("platform_verdict"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert git_ops.calls == []


@pytest.mark.asyncio
async def test_executor_no_merge_gate_resolver_preserves_ci_check():
    """Regression pin: existing call sites construct without resolve_merge_gate
    — CI gating must behave exactly as before the field existed."""
    git_ops = _FakeGitOps()
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_repo_url,
        check_ci=_ci_returning("pending"),
    )
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    assert git_ops.calls == []


class _Settings:
    GITHUB_TOKEN = "tok"
    GITLAB_TOKEN = ""
    GITEA_TOKEN = ""
    GIT_USER_NAME = "Backplane Merge Bot"
    GIT_USER_EMAIL = "merge-bot@valaris.studio"
    MERGE_REQUIRE_CI_GREEN = True


# --- missing-binary diagnostics (field report 2026-08-08) ----------
# The backend image shipped without git/gh; every merge attempt failed with a
# bare "[Errno 2] No such file or directory" that named nothing. The failure
# must name the binary, and the factory must warn at boot when PATH is bare.


async def test_run_capture_names_the_missing_binary():
    ops = SubprocessGitOps()
    with pytest.raises(GitOpsError) as exc_info:
        await ops._run_capture(
            "definitely-not-a-real-binary-xyz", "--version", cwd=None
        )
    assert "definitely-not-a-real-binary-xyz" in str(exc_info.value)
    assert "not found" in str(exc_info.value)


def test_make_merge_executor_warns_when_binaries_missing(monkeypatch, caplog):
    import logging as _logging

    from app.services import merge_executor as mod

    monkeypatch.setattr(mod.shutil, "which", lambda name: None)
    with caplog.at_level(_logging.WARNING):
        make_merge_executor(session_factory=None, settings=_Settings())
    warnings = [r.message for r in caplog.records if "not found on PATH" in r.message]
    assert any("git" in w for w in warnings)
    assert any("gh" in w for w in warnings)


def test_make_merge_executor_silent_when_binaries_present(monkeypatch, caplog):
    import logging as _logging

    from app.services import merge_executor as mod

    monkeypatch.setattr(mod.shutil, "which", lambda name: f"/usr/bin/{name}")
    with caplog.at_level(_logging.WARNING):
        make_merge_executor(session_factory=None, settings=_Settings())
    assert not [r for r in caplog.records if "not found on PATH" in r.message]


# --- github merge base-branch guard (field audit of a field run, 2026-08-09) ---
#
# `gh pr merge` lands the PR into ITS OWN base branch — the entry's
# integration_branch only drives the rebase target and queue keying. Without a
# base check, a PR mistakenly opened against the default branch would be
# rebased onto the integration branch and then merged into the default branch
# anyway: exactly the "never touch master" violation an engagement board
# forbids as a hard floor.


def _gh_view_then_ok(base_ref: str):
    """Subprocess fake: `gh pr view` answers with base_ref, everything else 0."""
    seen: list[tuple[str, ...]] = []

    async def _fake_create(*cmd, cwd, stdout, stderr, env=None):
        seen.append(cmd)
        if cmd[:3] == ("gh", "pr", "view"):
            return _FakeProcess(stdout=f'{{"baseRefName": "{base_ref}"}}'.encode())
        return _FakeProcess(returncode=0)

    return seen, _fake_create


@pytest.mark.asyncio
async def test_subprocess_git_ops_github_merge_checks_base_before_merging(
    monkeypatch,
):
    seen, fake = _gh_view_then_ok("secops-run")
    monkeypatch.setattr("asyncio.create_subprocess_exec", fake)

    ops = SubprocessGitOps()
    await ops.merge_pr(
        workdir=Path("/tmp/x"),
        pr_url="https://github.com/acme/widget/pull/7",
        forge="github",
        integration_branch="secops-run",
        pr_branch="secops/fix-1",
    )

    heads = [cmd[:3] for cmd in seen]
    assert ("gh", "pr", "view") in heads
    assert ("gh", "pr", "merge") in heads
    assert heads.index(("gh", "pr", "view")) < heads.index(("gh", "pr", "merge"))


@pytest.mark.asyncio
async def test_subprocess_git_ops_github_merge_refuses_base_mismatch(monkeypatch):
    seen, fake = _gh_view_then_ok("master")
    monkeypatch.setattr("asyncio.create_subprocess_exec", fake)

    ops = SubprocessGitOps()
    with pytest.raises(GitOpsError) as excinfo:
        await ops.merge_pr(
            workdir=Path("/tmp/x"),
            pr_url="https://github.com/acme/widget/pull/7",
            forge="github",
            integration_branch="secops-run",
            pr_branch="secops/fix-1",
        )

    # The refusal must name both branches so the entry's error_message tells
    # the operator (and the next agent iteration) exactly how to fix the PR.
    assert "master" in str(excinfo.value)
    assert "secops-run" in str(excinfo.value)
    assert ("gh", "pr", "merge") not in [cmd[:3] for cmd in seen]


@pytest.mark.asyncio
async def test_subprocess_git_ops_github_merge_skips_base_check_without_branch(
    monkeypatch,
):
    """Back-compat: callers that pass no integration_branch (empty default)
    keep the historical merge-blind behavior — the guard needs a branch to
    compare against."""
    seen, fake = _gh_view_then_ok("anything")
    monkeypatch.setattr("asyncio.create_subprocess_exec", fake)

    ops = SubprocessGitOps()
    await ops.merge_pr(
        workdir=Path("/tmp/x"),
        pr_url="https://github.com/acme/widget/pull/7",
        forge="github",
    )

    heads = [cmd[:3] for cmd in seen]
    assert ("gh", "pr", "view") not in heads
    assert ("gh", "pr", "merge") in heads
