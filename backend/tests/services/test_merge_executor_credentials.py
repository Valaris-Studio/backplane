# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Per-entry credential resolution in the merge executor (Phase 2).

Before this, `make_merge_executor` baked ONE global GITHUB_TOKEN into the
clone-URL rewrite and into `SubprocessGitOps(env_overrides={"GH_TOKEN": ...})`
at startup. Every workspace's merges therefore ran as the platform's account,
and a workspace whose forge the platform has no account on could not merge at
all.

Now the entry's repo resolves to a credential per attempt. Three things must
hold, and each one is a bug that shipped or nearly shipped:

1. The SAME credential drives both the clone URL and GH_TOKEN. Splitting them
   means `git` pushes as the workspace and `gh` merges as the platform.
2. No credential is NOT an error — public repos on self-hosted installs clone
   unauthenticated. But the resolution `detail` must reach `error_message` when
   something downstream then fails, or the operator sees "403" with no way to
   learn that the reason was a missing connection.
3. A 401/403 while USING a workspace connection marks that connection
   unhealthy; a success clears it.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider
from app.services.git.credential_resolver import (
    CredentialResolution,
    ForgeCredential,
    ResolutionReason,
)
from app.services.merge_executor import (
    EntryCredential,
    GitOpsError,
    MergeExecutor,
    RebaseResult,
)


def _entry(**overrides) -> MergeQueueEntry:
    fields = dict(
        id=uuid.uuid4(),
        repo_id=uuid.uuid4(),
        integration_branch="develop",
        card_id=uuid.uuid4(),
        pr_url="https://github.com/acme/acme/pull/7",
        pr_branch="feat/widget",
        workspace_id=uuid.uuid4(),
        state="merging",
        attempt_count=1,
    )
    fields.update(overrides)
    return MergeQueueEntry(**fields)


def _credential(
    *,
    token: str = "ghp_workspace",
    source: str = "workspace connection acme-bot",
    connection_id: uuid.UUID | None = None,
) -> ForgeCredential:
    return ForgeCredential(
        token=token,
        provider=GitProvider.github,
        host="github.com",
        username="x-access-token",
        source=source,
        connection_id=connection_id,
    )


def _entry_credential(
    *,
    url: str = "https://x-access-token:ghp_workspace@github.com/acme/acme.git",
    credential: ForgeCredential | None = None,
    resolution: CredentialResolution | None = None,
) -> EntryCredential:
    if credential is None and resolution is None:
        credential = _credential()
    return EntryCredential(
        url=url,
        credential=credential,
        resolution=resolution or CredentialResolution(credential=credential),
    )


class _RecordingGitOps:
    """Captures the token each op ran with, so a split between the clone URL
    and GH_TOKEN is visible to assertions."""

    def __init__(self, *, merge_pr_error: Exception | None = None):
        self.merge_pr_error = merge_pr_error
        self.calls: list[tuple[str, dict]] = []
        self.env_seen: list[dict[str, str] | None] = []

    async def clone(self, *, repo_url, branch, workdir, env=None) -> None:
        self.calls.append(("clone", {"repo_url": repo_url}))
        self.env_seen.append(env)

    async def fetch_branch(self, *, workdir, branch, env=None) -> None:
        self.calls.append(("fetch_branch", {}))
        self.env_seen.append(env)

    async def checkout(self, *, workdir, branch, env=None) -> None:
        self.calls.append(("checkout", {}))
        self.env_seen.append(env)

    async def rebase(self, *, workdir, onto, env=None) -> RebaseResult:
        self.calls.append(("rebase", {}))
        self.env_seen.append(env)
        return RebaseResult(success=True)

    async def push_force_with_lease(self, *, workdir, branch, env=None) -> None:
        self.calls.append(("push", {}))
        self.env_seen.append(env)

    async def merge_pr(
        self,
        *,
        workdir,
        pr_url,
        forge="github",
        integration_branch="",
        pr_branch="",
        env=None,
    ) -> None:
        self.calls.append(("merge_pr", {"pr_url": pr_url}))
        self.env_seen.append(env)
        if self.merge_pr_error is not None:
            raise self.merge_pr_error


def _resolver_returning(entry_credential: EntryCredential):
    async def _resolve(_entry: MergeQueueEntry) -> EntryCredential:
        return entry_credential

    return _resolve


@pytest.mark.asyncio
async def test_resolved_credential_drives_clone_url():
    git_ops = _RecordingGitOps()
    executor = MergeExecutor(
        git_ops=git_ops, resolve_credential=_resolver_returning(_entry_credential())
    )

    outcome = await executor(_entry())

    assert outcome[0] == "merged"
    assert git_ops.calls[0][1]["repo_url"] == (
        "https://x-access-token:ghp_workspace@github.com/acme/acme.git"
    )


@pytest.mark.asyncio
async def test_resolved_credential_drives_gh_token_for_every_op():
    """The clone URL and GH_TOKEN must be the SAME credential — otherwise git
    pushes as the workspace while gh merges as the platform."""
    git_ops = _RecordingGitOps()
    executor = MergeExecutor(
        git_ops=git_ops, resolve_credential=_resolver_returning(_entry_credential())
    )

    await executor(_entry())

    assert git_ops.env_seen, "no op received an env"
    for env in git_ops.env_seen:
        assert env == {"GH_TOKEN": "ghp_workspace"}


@pytest.mark.asyncio
async def test_credential_is_resolved_once_per_entry_not_per_op():
    calls = 0

    async def _resolve(_entry: MergeQueueEntry) -> EntryCredential:
        nonlocal calls
        calls += 1
        return _entry_credential()

    executor = MergeExecutor(git_ops=_RecordingGitOps(), resolve_credential=_resolve)
    await executor(_entry())

    assert calls == 1


@pytest.mark.asyncio
async def test_no_credential_still_attempts_the_merge_unauthenticated():
    """Public repos on self-hosted installs must keep working — no credential
    is the historical no-token path, not a failure."""
    git_ops = _RecordingGitOps()
    resolution = CredentialResolution(
        credential=None,
        reason=ResolutionReason.no_connection,
        detail="No github credential is available for 'github.com'.",
    )
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolver_returning(
            _entry_credential(
                url="https://github.com/acme/acme.git", resolution=resolution
            )
        ),
    )

    outcome = await executor(_entry())

    assert outcome[0] == "merged"
    assert git_ops.calls[0][1]["repo_url"] == "https://github.com/acme/acme.git"
    assert git_ops.env_seen[0] == {}


@pytest.mark.asyncio
async def test_failure_without_credential_explains_why_there_was_none():
    """A bare "403" teaches the operator nothing. The resolution detail is the
    only thing that names the missing connection."""
    git_ops = _RecordingGitOps(
        merge_pr_error=GitOpsError("gh pr merge failed (rc=1): HTTP 403")
    )
    resolution = CredentialResolution(
        credential=None,
        reason=ResolutionReason.no_connection,
        detail=(
            "No github credential is available for 'github.com': this workspace "
            "has no github connection and the platform has no github token "
            "configured."
        ),
    )
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolver_returning(
            _entry_credential(
                url="https://github.com/acme/acme.git", resolution=resolution
            )
        ),
    )

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "HTTP 403" in outcome[1]
    assert "this workspace has no github connection" in outcome[1]


@pytest.mark.asyncio
async def test_failure_with_credential_names_its_source():
    """"403 using workspace connection acme-bot" tells the operator exactly
    which credential to go fix."""
    git_ops = _RecordingGitOps(
        merge_pr_error=GitOpsError("gh pr merge failed (rc=1): HTTP 403")
    )
    executor = MergeExecutor(
        git_ops=git_ops, resolve_credential=_resolver_returning(_entry_credential())
    )

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "using workspace connection acme-bot" in outcome[1]


@pytest.mark.asyncio
async def test_failure_message_redacts_a_leaked_token():
    """git echoes the whole clone URL on auth failure; error_message is stored
    in the DB and shown in the UI."""
    git_ops = _RecordingGitOps(
        merge_pr_error=GitOpsError(
            "fatal: could not read from "
            "https://x-access-token:ghp_REALSECRET@github.com/acme/acme.git"
        )
    )
    executor = MergeExecutor(
        git_ops=git_ops, resolve_credential=_resolver_returning(_entry_credential())
    )

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "ghp_REALSECRET" not in outcome[1]
    assert "***@github.com" in outcome[1]


@pytest.mark.asyncio
async def test_platform_token_source_named_on_failure():
    git_ops = _RecordingGitOps(merge_pr_error=GitOpsError("HTTP 401"))
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(source="platform token"))
        ),
    )

    outcome = await executor(_entry())

    assert "using platform token" in outcome[1]


# --- connection health bookkeeping -----------------------------------------


@pytest.mark.asyncio
async def test_auth_failure_marks_the_connection_unhealthy():
    connection_id = uuid.uuid4()
    recorded: list[tuple[uuid.UUID, str]] = []

    async def _on_auth_failure(cid: uuid.UUID, message: str) -> None:
        recorded.append((cid, message))

    git_ops = _RecordingGitOps(
        merge_pr_error=GitOpsError("gh pr merge failed (rc=1): HTTP 401")
    )
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(connection_id=connection_id))
        ),
        on_auth_failure=_on_auth_failure,
    )

    await executor(_entry())

    assert len(recorded) == 1
    assert recorded[0][0] == connection_id
    assert "401" in recorded[0][1]


@pytest.mark.asyncio
async def test_non_auth_failure_does_not_mark_the_connection_unhealthy():
    """A rebase conflict or a missing branch says nothing about the
    credential — marking it unhealthy would send the operator to rotate a
    perfectly good token."""
    recorded: list[uuid.UUID] = []

    async def _on_auth_failure(cid, message) -> None:
        recorded.append(cid)

    git_ops = _RecordingGitOps(
        merge_pr_error=GitOpsError("gh pr merge failed (rc=1): not mergeable")
    )
    executor = MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(connection_id=uuid.uuid4()))
        ),
        on_auth_failure=_on_auth_failure,
    )

    await executor(_entry())

    assert recorded == []


@pytest.mark.asyncio
async def test_platform_token_auth_failure_records_nothing():
    """The platform token has no connection row to mark."""
    recorded: list[uuid.UUID] = []

    async def _on_auth_failure(cid, message) -> None:
        recorded.append(cid)

    executor = MergeExecutor(
        git_ops=_RecordingGitOps(merge_pr_error=GitOpsError("HTTP 401")),
        resolve_credential=_resolver_returning(
            _entry_credential(
                credential=_credential(source="platform token", connection_id=None)
            )
        ),
        on_auth_failure=_on_auth_failure,
    )

    await executor(_entry())

    assert recorded == []


@pytest.mark.asyncio
async def test_successful_merge_clears_the_connections_recorded_failure():
    connection_id = uuid.uuid4()
    cleared: list[uuid.UUID] = []

    async def _on_auth_success(cid: uuid.UUID) -> None:
        cleared.append(cid)

    executor = MergeExecutor(
        git_ops=_RecordingGitOps(),
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(connection_id=connection_id))
        ),
        on_auth_success=_on_auth_success,
    )

    outcome = await executor(_entry())

    assert outcome[0] == "merged"
    assert cleared == [connection_id]


@pytest.mark.asyncio
async def test_health_bookkeeping_failure_never_breaks_the_merge():
    """A health write is bookkeeping. If it throws, the operator must still
    get the REAL error, not the bookkeeping one."""

    async def _boom(*args) -> None:
        raise RuntimeError("health db down")

    executor = MergeExecutor(
        git_ops=_RecordingGitOps(merge_pr_error=GitOpsError("HTTP 401")),
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(connection_id=uuid.uuid4()))
        ),
        on_auth_failure=_boom,
    )

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "401" in outcome[1]
    assert "health db down" not in outcome[1]


@pytest.mark.asyncio
async def test_health_bookkeeping_failure_never_breaks_a_successful_merge():
    async def _boom(*args) -> None:
        raise RuntimeError("health db down")

    executor = MergeExecutor(
        git_ops=_RecordingGitOps(),
        resolve_credential=_resolver_returning(
            _entry_credential(credential=_credential(connection_id=uuid.uuid4()))
        ),
        on_auth_success=_boom,
    )

    outcome = await executor(_entry())

    assert outcome[0] == "merged"


@pytest.mark.asyncio
async def test_credential_resolution_failure_is_a_failed_outcome_not_a_crash():
    """The resolver hits the DB; a session error must not escape into the
    queue worker's tick."""

    async def _resolve(_entry):
        raise RuntimeError("db gone")

    executor = MergeExecutor(git_ops=_RecordingGitOps(), resolve_credential=_resolve)

    outcome = await executor(_entry())

    assert outcome[0] == "failed"
    assert "db gone" in outcome[1]


# --- CI gate posture is unchanged -------------------------------------------


@pytest.mark.asyncio
async def test_ci_gate_still_fails_closed_and_runs_before_resolution():
    """The CI gate is fail-CLOSED and runs first so a pending CI costs no
    clone. Credential resolution must not have moved in front of it."""
    resolved = False

    async def _resolve(_entry):
        nonlocal resolved
        resolved = True
        return _entry_credential()

    async def _check_ci(_entry):
        return "pending"

    git_ops = _RecordingGitOps()
    executor = MergeExecutor(
        git_ops=git_ops, resolve_credential=_resolve, check_ci=_check_ci
    )

    outcome = await executor(_entry())

    assert outcome[0] == "ci_not_green"
    assert git_ops.calls == []
    assert resolved is False
