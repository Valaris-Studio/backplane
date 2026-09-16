# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 2c + Option B: the merge executor must be forge-provider-aware.

The executor passes the repo's provider through to merge_pr. GitHub keeps using
`gh pr merge` (byte-identical). Per Option B, a NON-GitHub provider is merged via
plain git (checkout integration -> merge --ff-only pr_branch -> push), which
works on ANY git host without a per-host PR-merge API. The PR/MR is left as-is on
the host UI (no per-host close call) — purest provider-agnostic path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.merge_executor import (
    GitOpsError,
    MergeExecutor,
    RebaseResult,
    SubprocessGitOps,
)

from tests.services.test_merge_executor import _entry


class _ForgeRecordingGitOps:
    """Records the args merge_pr was called with."""

    def __init__(self) -> None:
        self.merge_kwargs: dict | None = None
        self.rebase_result = RebaseResult(success=True)

    async def clone(
        self, *, repo_url: str, branch: str, workdir: Path, env=None
    ) -> None: ...
    async def fetch_branch(
        self, *, workdir: Path, branch: str, env=None
    ) -> None: ...
    async def checkout(self, *, workdir: Path, branch: str, env=None) -> None: ...

    async def rebase(self, *, workdir: Path, onto: str, env=None) -> RebaseResult:
        return self.rebase_result

    async def push_force_with_lease(
        self, *, workdir: Path, branch: str, env=None
    ) -> None: ...

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
        self.merge_kwargs = {
            "pr_url": pr_url,
            "forge": forge,
            "integration_branch": integration_branch,
            "pr_branch": pr_branch,
        }


@pytest.mark.asyncio
async def test_executor_passes_repo_forge_to_merge_pr():
    git_ops = _ForgeRecordingGitOps()

    async def _resolve_url(_entry) -> str:
        return "https://gitlab.com/acme/acme.git"

    async def _resolve_forge(_entry) -> str:
        return "gitlab"

    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_url,
        resolve_forge=_resolve_forge,
    )
    outcome = await executor(_entry(integration_branch="develop", pr_branch="feat/x"))

    assert outcome[0] == "merged"
    assert git_ops.merge_kwargs is not None
    assert git_ops.merge_kwargs["forge"] == "gitlab"


@pytest.mark.asyncio
async def test_executor_threads_branches_to_merge_pr():
    """Option B needs the integration + PR branch at the merge step so a
    non-github plain-git merge can fast-forward integration to the PR tip."""
    git_ops = _ForgeRecordingGitOps()

    async def _resolve_url(_entry) -> str:
        return "https://gitea.example.com/acme/acme.git"

    async def _resolve_forge(_entry) -> str:
        return "gitea"

    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_repo_url=_resolve_url,
        resolve_forge=_resolve_forge,
    )
    await executor(_entry(integration_branch="develop", pr_branch="feat/widget"))

    assert git_ops.merge_kwargs["integration_branch"] == "develop"
    assert git_ops.merge_kwargs["pr_branch"] == "feat/widget"


@pytest.mark.asyncio
async def test_executor_defaults_forge_to_github_when_no_resolver():
    """Backward compat: an executor built without resolve_forge defaults to
    github, so every existing call site keeps working unchanged."""
    git_ops = _ForgeRecordingGitOps()

    async def _resolve_url(_entry) -> str:
        return "https://github.com/acme/acme.git"

    executor = MergeExecutor(git_ops=git_ops, resolve_repo_url=_resolve_url)
    await executor(_entry())

    assert git_ops.merge_kwargs["forge"] == "github"


@pytest.mark.asyncio
async def test_subprocess_merge_pr_github_uses_gh(monkeypatch):
    captured: dict = {}

    async def _fake_run(self, *cmd, cwd, env=None):  # noqa: ANN001
        captured["cmd"] = cmd

    monkeypatch.setattr(SubprocessGitOps, "_run", _fake_run)
    ops = SubprocessGitOps()
    await ops.merge_pr(
        workdir=Path("/tmp"), pr_url="https://github.com/a/b/pull/1", forge="github"
    )

    assert captured["cmd"][0] == "gh"
    assert "merge" in captured["cmd"]


@pytest.mark.asyncio
async def test_subprocess_merge_pr_nongithub_uses_plain_git(monkeypatch):
    """Option B: a non-github provider merges via plain git — no `gh`, no
    per-host PR-merge API. The executor already rebased pr_branch onto
    integration_branch and force-pushed it, so finalizing is a guaranteed
    fast-forward of integration to the PR tip:
        git checkout <integration> ; git merge --ff-only <pr_branch> ; git push
    Works on ANY git host."""
    cmds: list = []

    async def _fake_run(self, *cmd, cwd, env=None):  # noqa: ANN001
        cmds.append(cmd)

    monkeypatch.setattr(SubprocessGitOps, "_run", _fake_run)
    ops = SubprocessGitOps()

    await ops.merge_pr(
        workdir=Path("/tmp"),
        pr_url="https://gitlab.com/a/b/-/merge_requests/1",
        forge="gitlab",
        integration_branch="develop",
        pr_branch="feat/widget",
    )

    # No `gh` anywhere.
    assert all(c[0] != "gh" for c in cmds), cmds
    joined = [" ".join(c) for c in cmds]
    # Checkout the integration branch, fast-forward-only merge the PR branch,
    # push the integration branch back.
    # `--` separates the caller-supplied branch from git's own options; see
    # test_subprocess_git_ops_separates_branches_on_plain_git_merge.
    assert any("checkout develop" in j for j in joined), joined
    assert any("merge --ff-only -- feat/widget" in j for j in joined), joined
    assert any("push origin -- develop" in j for j in joined), joined


@pytest.mark.asyncio
async def test_subprocess_merge_pr_nongithub_requires_branches(monkeypatch):
    """The plain-git path is meaningless without both branch names — fail
    loudly rather than run a half-formed git command."""

    async def _fake_run(self, *cmd, cwd, env=None):  # noqa: ANN001
        pass

    monkeypatch.setattr(SubprocessGitOps, "_run", _fake_run)
    ops = SubprocessGitOps()

    with pytest.raises(GitOpsError):
        await ops.merge_pr(
            workdir=Path("/tmp"),
            pr_url="https://gitea.example.com/a/b/pulls/1",
            forge="gitea",
            integration_branch="",
            pr_branch="feat/widget",
        )
