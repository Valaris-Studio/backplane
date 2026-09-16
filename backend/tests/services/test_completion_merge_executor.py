# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.services.merge_executor import MergeExecutor, RebaseResult, SubprocessGitOps
from tests.services.test_merge_executor import _entry, _resolve_repo_url


async def test_reviewed_merge_never_rewrites_reviewed_head():
    ops = SimpleNamespace(**{name: AsyncMock() for name in (
        "clone", "fetch_branch", "checkout", "push_force_with_lease", "merge_pr",
    )}, rebase=AsyncMock(return_value=RebaseResult(success=True)))
    executor = MergeExecutor(git_ops=ops, resolve_repo_url=_resolve_repo_url,
                             resolve_completion=AsyncMock(return_value={"source_sha": "a" * 40, "require_forge_checks": False}))
    outcome = await executor(_entry())
    assert outcome[0] == "merged"
    ops.rebase.assert_not_awaited()
    ops.push_force_with_lease.assert_not_awaited()
    assert ops.merge_pr.await_args.kwargs["expected_head_sha"] == "a" * 40


async def test_explicit_required_checks_cannot_be_disabled_by_global_executor_default():
    ops = SimpleNamespace(clone=AsyncMock())
    executor = MergeExecutor(git_ops=ops, resolve_repo_url=_resolve_repo_url,
                             resolve_completion=AsyncMock(return_value={"source_sha": "a" * 40, "require_forge_checks": True}))
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    ops.clone.assert_not_awaited()


async def test_explicit_required_checks_hold_when_forge_has_no_checks():
    ops = SimpleNamespace(clone=AsyncMock())
    executor = MergeExecutor(git_ops=ops, resolve_repo_url=_resolve_repo_url,
                             check_ci=AsyncMock(return_value="none"),
                             resolve_completion=AsyncMock(return_value={"source_sha": "a" * 40, "require_forge_checks": True}))
    outcome = await executor(_entry())
    assert outcome[0] == "ci_not_green"
    ops.clone.assert_not_awaited()


async def test_subprocess_merge_enforces_expected_head_atomically():
    ops = SubprocessGitOps()
    ops._run = AsyncMock()
    await ops.merge_pr(workdir=Path("/tmp"), pr_url="https://github.com/acme/acme/pull/7", expected_head_sha="a" * 40)
    args = ops._run.await_args.args
    assert args[args.index("--match-head-commit") + 1] == "a" * 40
    assert "--admin" not in args
