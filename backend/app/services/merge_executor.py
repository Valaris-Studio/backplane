# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Real MergeExecutor for the backend-owned merge queue (PAR-3b).

The executor is invoked by `MergeQueueService.process_entry`. It owns the
git + gh shellout sequence end-to-end so the queue logic stays free of
subprocess concerns. All git/gh interaction is funneled through the
`GitOps` Protocol so unit tests substitute a fake at that boundary
instead of stubbing `asyncio.create_subprocess_exec`.

Pipeline on the clean path:
  clone(integration_branch)
    -> fetch_branch(pr_branch)
    -> checkout(pr_branch)
    -> rebase(onto=integration_branch)
    -> push_force_with_lease(pr_branch)
    -> merge_pr(pr_url)

A rebase conflict short-circuits the pipeline before push/merge and is
returned as a structured outcome rather than an exception — the queue
worker turns it into a `mark_conflict` row plus a consolidator card
(PAR-3c). All other subprocess failures bubble out of `GitOps` as
`GitOpsError` and become `("failed", message)` outcomes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Protocol
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitRepo
from app.services.git.credential_resolver import (
    CredentialResolution,
    CredentialResolver,
    ForgeCredential,
)
from app.services.git.redaction import redact_url_credentials
from app.services.merge_queue import MergeResult


logger = logging.getLogger(__name__)


def _connection_service(session: AsyncSession):
    """GitConnectionService with the platform vault, for health bookkeeping.

    Imported lazily: git_connection.py pulls in the activity/probe stack, and
    the merge executor is imported at app boot.
    """
    from app import config as _config
    from app.integrations.git.vault import FernetTokenVault
    from app.services.git.git_connection import GitConnectionService

    return GitConnectionService(
        session,
        vault=FernetTokenVault(_config.settings.INTEGRATIONS_TOKEN_KEY.encode()),
    )


class GitOpsError(Exception):
    """Raised by GitOps when a git/gh subprocess fails non-recoverably.

    Rebase conflicts are NOT this — they come back as RebaseResult so the
    executor can short-circuit cleanly.
    """


@dataclass
class RebaseConflict:
    files: list[str]
    stderr: str


@dataclass
class RebaseResult:
    success: bool
    conflict: RebaseConflict | None = None


class GitOps(Protocol):
    """Every op takes the attempt's `env` because credentials are per-entry.

    `env` carries `GH_TOKEN` for the credential this entry resolved to (empty
    when it resolved to none). It cannot live on the GitOps instance: the
    executor is built once at startup and serves every workspace, so a
    constructor-baked token would be the global token this program exists to
    remove.
    """

    async def clone(
        self, *, repo_url: str, branch: str, workdir: Path, env: dict[str, str] | None = None
    ) -> None: ...

    async def fetch_branch(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None: ...

    async def checkout(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None: ...

    async def rebase(
        self, *, workdir: Path, onto: str, env: dict[str, str] | None = None
    ) -> RebaseResult: ...

    async def push_force_with_lease(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None: ...

    async def merge_pr(
        self,
        *,
        workdir: Path,
        pr_url: str,
        forge: str = "github",
        integration_branch: str = "",
        pr_branch: str = "",
        env: dict[str, str] | None = None,
        expected_head_sha: str | None = None,
    ) -> None: ...


@dataclass(frozen=True)
class EntryCredential:
    """What one merge attempt resolved to.

    `url` is the clone URL with the credential embedded (or the bare URL when
    there is none). `resolution` is kept even on success because its `detail`
    is the only operator-facing explanation of WHY a merge ran without a
    credential — a bare "403" from git names nothing.
    """

    url: str
    credential: "ForgeCredential | None"
    resolution: "CredentialResolution"


# Substrings that mark a git/gh failure as a CREDENTIAL problem rather than a
# repository-state one. Only these mark a connection unhealthy: a rebase
# conflict or a protected branch says nothing about the token, and flagging it
# would send an operator to rotate a perfectly good credential.
_AUTH_FAILURE_MARKERS = (
    "401",
    "403",
    "authentication failed",
    "bad credentials",
    "could not read username",
    "permission denied",
    "invalid username or password",
    "requires authentication",
)


def _is_auth_failure(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _AUTH_FAILURE_MARKERS)


async def resolve_board_merge_gate(db: AsyncSession, repo_id: uuid.UUID) -> str:
    """Resolve the per-board merge_gate policy for the board owning `repo_id`.

    Read live per attempt (not cached at enqueue) so flipping the knob
    unsticks already-queued entries. No board, no loop config, or a
    pre-merge_gate stored row all resolve to "forge_ci" — the default gate.
    """
    from app.models.kanban.board import Board

    loop_config = (
        await db.execute(
            select(Board.loop_config)
            .join(GitRepo, GitRepo.board_id == Board.id)
            .where(GitRepo.id == repo_id)
        )
    ).scalar_one_or_none()
    if loop_config is None:
        return "forge_ci"
    return loop_config.get("merge_gate", "forge_ci")


class MergeExecutor:
    """Callable that drives one MergeQueueEntry through the merge pipeline.

    Construct once per worker (the GitOps + URL resolver are stateless) and
    pass into `MergeQueueService.tick(executor=...)`.

    The resolver is async because the production resolver does a DB lookup
    of `GitRepo` by `entry.repo_id` and then rewrites the URL with a token;
    making it async keeps the DB call inside the cooperative loop instead
    of forcing a sync wrapper around an AsyncSession.
    """

    def __init__(
        self,
        *,
        git_ops: GitOps,
        resolve_repo_url: Callable[[MergeQueueEntry], Awaitable[str]] | None = None,
        resolve_credential: (
            Callable[[MergeQueueEntry], Awaitable[EntryCredential]] | None
        ) = None,
        resolve_forge: Callable[[MergeQueueEntry], Awaitable[str]] | None = None,
        check_ci: Callable[[MergeQueueEntry], Awaitable[str]] | None = None,
        require_ci_present: bool = False,
        resolve_merge_gate: Callable[[MergeQueueEntry], Awaitable[str]] | None = None,
        resolve_completion: Callable[[MergeQueueEntry], Awaitable[dict | None]] | None = None,
        on_auth_failure: (
            Callable[[uuid.UUID, str], Awaitable[None]] | None
        ) = None,
        on_auth_success: Callable[[uuid.UUID], Awaitable[None]] | None = None,
    ) -> None:
        self._git_ops = git_ops
        # `resolve_credential` is the real seam (URL + credential + why).
        # `resolve_repo_url` is the URL-only form kept for call sites that
        # don't care about credentials — tests, and anything constructing an
        # executor for a repo whose auth is already settled.
        if resolve_credential is None:
            if resolve_repo_url is None:
                raise TypeError(
                    "MergeExecutor needs resolve_credential or resolve_repo_url"
                )
            resolve_credential = _url_only_credential_resolver(resolve_repo_url)
        self._resolve_credential = resolve_credential
        self._resolve_repo_url = resolve_repo_url
        # Connection-health bookkeeping. Both are best-effort: a health-write
        # failure must never replace the real merge error (see _record_health).
        self._on_auth_failure = on_auth_failure
        self._on_auth_success = on_auth_success
        # Provider-agnostic merge: the executor asks the forge of the entry's
        # repo so merge_pr can dispatch (gh for GitHub, glab/API for others).
        # Defaults to "github" when no resolver is supplied, preserving the
        # historical single-provider behavior for existing call sites/tests.
        self._resolve_forge = resolve_forge
        # require_ci_green (card 51810501): tri-state+none CI verdict for the
        # entry's PR ("green" | "pending" | "red" | "none"). None = no check,
        # the historical behavior. require_ci_present promotes "none" (repo
        # has no CI at all) from fail-open to blocking.
        self._check_ci = check_ci
        self._require_ci_present = require_ci_present
        # Per-board merge_gate policy: "none" skips the CI gate for boards
        # whose repos have no usable CI. No resolver = "forge_ci" everywhere,
        # preserving existing call sites unchanged.
        self._resolve_merge_gate = resolve_merge_gate
        self._resolve_completion = resolve_completion

    async def __call__(self, entry: MergeQueueEntry) -> MergeResult:
        # `_run` resolves the credential (after the CI gate, so a pending CI
        # costs neither a clone nor a DB round-trip) and reports what it got
        # back through this box — the failure handlers below need it to explain
        # WHICH credential was in play, and they must work even when the throw
        # happened before resolution.
        box: list[EntryCredential] = []
        try:
            result = await self._run(entry, box)
        except GitOpsError as exc:
            return ("failed", await self._annotate_failure(str(exc), box))
        except Exception as exc:
            # Defense-in-depth: a GitOps impl that raises anything other
            # than GitOpsError still gets recorded as failed rather than
            # bubbling into the queue worker.
            return ("failed", await self._annotate_failure(str(exc), box))

        if result[0] == "merged" and box:
            await self._record_auth_success(box[0])
        return result

    async def _annotate_failure(
        self, message: str, box: list[EntryCredential]
    ) -> str:
        """Attach the credential story to a failure, and mark the connection
        unhealthy when the failure was the credential's fault.

        Without this an operator reads "HTTP 403" and has no way to learn
        whether the platform used their workspace connection, the platform
        token, or nothing at all — which is the difference between "rotate my
        PAT" and "I never connected an account".
        """
        safe = _redact_url_credentials(message)
        if not box:
            return safe
        resolved = box[0]

        if resolved.credential is not None:
            if _is_auth_failure(safe):
                await self._record_auth_failure(resolved, safe)
            return f"{safe} (using {resolved.credential.source})"

        detail = resolved.resolution.detail
        return f"{safe} — no credential was used: {detail}" if detail else safe

    async def _record_auth_failure(
        self, resolved: EntryCredential, message: str
    ) -> None:
        credential = resolved.credential
        if (
            self._on_auth_failure is None
            or credential is None
            or credential.connection_id is None
        ):
            return
        try:
            await self._on_auth_failure(credential.connection_id, message)
        except Exception:
            logging.getLogger(__name__).warning(
                "merge executor: could not mark connection %s unhealthy",
                credential.connection_id,
                exc_info=True,
            )

    async def _record_auth_success(self, resolved: EntryCredential) -> None:
        if self._on_auth_success is None:
            return
        credential = resolved.credential
        if credential is None or credential.connection_id is None:
            return
        try:
            await self._on_auth_success(credential.connection_id)
        except Exception:
            logging.getLogger(__name__).warning(
                "merge executor: could not clear connection %s health",
                credential.connection_id,
                exc_info=True,
            )

    async def _run(
        self, entry: MergeQueueEntry, box: list[EntryCredential]
    ) -> MergeResult:
        completion = await self._resolve_completion(entry) if self._resolve_completion else None
        expected_head_sha = completion["source_sha"] if completion else None
        strict_checks = bool(completion and completion["require_forge_checks"])
        if strict_checks and self._check_ci is None:
            return ("ci_not_green", "Required forge checks are unavailable; configure the check capability")
        # CI gate runs FIRST — a pending CI must not cost a clone per 10s
        # tick. The verdict therefore validates the PRE-rebase head; the
        # rebased commit re-runs CI after the force-push and stays visible on
        # the PR. Deliberate inversion of the house soft-pass posture: a merge
        # gate that cannot READ the checks blocks-and-retries, never merges on
        # a guess.
        if self._check_ci is not None:
            if completion is not None:
                gate = "forge_ci" if strict_checks else "none"
            elif self._resolve_merge_gate is not None:
                try:
                    gate = await self._resolve_merge_gate(entry)
                except Exception:
                    # Unreadable board policy fails closed TO the CI check —
                    # a lookup failure must never widen the gate to skipping.
                    gate = "forge_ci"
            else:
                gate = "forge_ci"
            # Only an explicit "none" opts out; unrecognized values fail
            # closed to checking.
            if gate != "none":
                try:
                    ci = await self._check_ci(entry)
                except Exception as exc:
                    return ("ci_not_green", f"ci state unreadable: {exc}")
                if ci == "red":
                    return ("ci_not_green", "ci red on PR head")
                if ci == "pending":
                    return ("ci_not_green", "ci pending on PR head")
                if ci not in ("green", "none"):
                    return ("ci_not_green", "unknown forge check result")
                if ci == "none" and (self._require_ci_present or strict_checks):
                    return (
                        "ci_not_green",
                        "no ci configured (require_ci_present)",
                    )

        # Per-entry, not per-worker: this repo's workspace may own a credential
        # the platform doesn't have, and the platform may own one this repo's
        # host never issued. Resolved once here and used by BOTH the clone URL
        # and the GH_TOKEN below, so git and gh always act as the same account.
        resolved = await self._resolve_credential(entry)
        box.append(resolved)
        env = (
            {"GH_TOKEN": resolved.credential.token}
            if resolved.credential is not None
            else {}
        )

        with tempfile.TemporaryDirectory(prefix="merge-exec-") as tmp:
            workdir = Path(tmp)

            await self._git_ops.clone(
                repo_url=resolved.url,
                branch=entry.integration_branch,
                workdir=workdir,
                env=env,
            )
            await self._git_ops.fetch_branch(
                workdir=workdir, branch=entry.pr_branch, env=env
            )
            await self._git_ops.checkout(
                workdir=workdir, branch=entry.pr_branch, env=env
            )

            if not expected_head_sha:
                rebase = await self._git_ops.rebase(
                    workdir=workdir, onto=entry.integration_branch, env=env
                )
                if not rebase.success:
                    return ("conflict", _format_conflict(rebase.conflict))
                await self._git_ops.push_force_with_lease(
                    workdir=workdir, branch=entry.pr_branch, env=env
                )
            forge = (
                await self._resolve_forge(entry)
                if self._resolve_forge is not None
                else "github"
            )
            await self._git_ops.merge_pr(
                workdir=workdir,
                pr_url=entry.pr_url,
                forge=forge,
                integration_branch=entry.integration_branch,
                pr_branch=entry.pr_branch,
                env=env,
                **({"expected_head_sha": expected_head_sha} if expected_head_sha else {}),
            )

        return ("merged", datetime.utcnow())


def _format_conflict(conflict: RebaseConflict | None) -> str:
    if conflict is None:
        return "rebase reported conflict but no file list was provided"
    files = ", ".join(conflict.files) if conflict.files else "<unknown>"
    return f"rebase conflict in: {files}"


# ---------------------------------------------------------------------------
# Real subprocess-backed GitOps
# ---------------------------------------------------------------------------


# Matches `UU app/foo.py` and `AA app/bar.py` lines from `git status --porcelain=v1`.
# Both-modified (UU) is the dominant case in a rebase conflict; AA / DD / etc.
# are the other unmerged-state codes — see `git help status`.
_UNMERGED_STATUS_PATTERN = re.compile(r"^(?:UU|AA|DD|AU|UA|DU|UD)\s+(.+)$")

# The only transports a merge ever legitimately needs. Pinning this closes the
# remote-helper class (`ext::`, `fd::`) at the exec edge: `ext::sh -c <cmd>`
# makes git run <cmd>, so a repo URL that reaches git unvalidated is RCE. The
# schema validators already reject those URLs — this is the defence that holds
# when a future ingress forgets to validate. No `file`: the executor only ever
# clones remote forge URLs.
_GIT_ALLOWED_PROTOCOLS = "https:http:ssh:git"


class SubprocessGitOps:
    """Real GitOps implementation backed by `git` + `gh` subprocesses.

    Each method shells out via `asyncio.create_subprocess_exec` so the
    worker stays cooperative. Non-zero return codes (other than the
    rebase-conflict path) raise `GitOpsError` carrying the captured stderr.

    `env_overrides` is merged onto `os.environ` and passed to every child
    process. Per-call `env` (the entry's resolved `GH_TOKEN`) is merged on top
    of it: credentials are per-entry now, so they arrive per call rather than
    baked into the instance — one executor serves every workspace.
    `git_identity` is injected as `git -c user.name=… -c user.email=…` flags
    only on commands that author commits (rebase, push); clone/fetch/checkout
    don't need them.
    """

    def __init__(
        self,
        *,
        env_overrides: dict[str, str] | None = None,
        git_identity: tuple[str, str] | None = None,
    ) -> None:
        self._env_overrides = env_overrides or {}
        self._git_identity = git_identity

    # `--` before any url/ref keeps git from parsing a `-`-leading value as an
    # option (`--upload-pack=cmd` would execute cmd). The schema rejects such
    # values on the way in; this is the second line of defence at the exec edge.
    async def clone(
        self,
        *,
        repo_url: str,
        branch: str,
        workdir: Path,
        env: dict[str, str] | None = None,
    ) -> None:
        # `git clone` insists on an empty target; the temp dir handed to us
        # is freshly created and empty, so a direct clone-into is fine.
        await self._run(
            "git",
            "clone",
            "--branch",
            branch,
            "--",
            repo_url,
            str(workdir),
            cwd=None,
            env=env,
        )

    async def fetch_branch(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None:
        await self._run(
            "git", "fetch", "origin", "--", branch, cwd=workdir, env=env
        )

    async def checkout(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None:
        # After fetch we have origin/<branch> as a remote ref; the local
        # branch may not exist yet, so use `-B` to create-or-reset it onto
        # the fetched ref. No `--` here: it would make the start-point a
        # pathspec. Both operands are option-safe anyway — `-B` consumes the
        # branch name, and the start-point is `origin/`-prefixed.
        await self._run(
            "git",
            "checkout",
            "-B",
            branch,
            f"origin/{branch}",
            cwd=workdir,
            env=env,
        )

    async def rebase(
        self, *, workdir: Path, onto: str, env: dict[str, str] | None = None
    ) -> RebaseResult:
        rc, _stdout, stderr = await self._run_capture(
            *self._git_with_identity("rebase", f"origin/{onto}"),
            cwd=workdir,
            env=env,
        )
        if rc == 0:
            return RebaseResult(success=True)

        files = await self._collect_unmerged_files(workdir, env=env)
        # Leave the workdir in a clean state regardless of whether the
        # rebase succeeded (the temp dir is torn down by the caller, but
        # an uncleaned rebase state would still trip future ops if the
        # workdir were ever reused).
        await self._run_capture("git", "rebase", "--abort", cwd=workdir, env=env)
        return RebaseResult(
            success=False,
            conflict=RebaseConflict(files=files, stderr=stderr),
        )

    async def push_force_with_lease(
        self, *, workdir: Path, branch: str, env: dict[str, str] | None = None
    ) -> None:
        # `git push --receive-pack=cmd` makes git spawn `/bin/sh -c cmd`, so the
        # branch must sit after `--`.
        await self._run(
            *self._git_with_identity(
                "push", "--force-with-lease", "origin", "--", branch
            ),
            cwd=workdir,
            env=env,
        )

    async def merge_pr(
        self,
        *,
        workdir: Path,
        pr_url: str,
        forge: str = "github",
        integration_branch: str = "",
        pr_branch: str = "",
        env: dict[str, str] | None = None,
        expected_head_sha: str | None = None,
    ) -> None:
        if expected_head_sha and (forge != "github" or not re.fullmatch(r"[0-9a-fA-F]{40,64}", expected_head_sha)):
            raise GitOpsError("Exact reviewed-head merging requires a supported forge and full source SHA")
        if forge == "github":
            # `gh pr merge` lands the PR into ITS OWN base branch — the
            # entry's integration_branch only drives the rebase target. Verify
            # they agree before merging, or a PR mistakenly opened against the
            # default branch would be rebased onto the integration branch and
            # then merged into the default branch anyway.
            if integration_branch:
                rc, stdout, stderr = await self._run_capture(
                    "gh",
                    "pr",
                    "view",
                    pr_url,
                    "--json",
                    "baseRefName",
                    cwd=workdir,
                    env=env,
                )
                if rc != 0:
                    raise GitOpsError(
                        f"gh pr view failed (rc={rc}): "
                        f"{_redact_url_credentials(stderr)}"
                    )
                base = json.loads(stdout).get("baseRefName", "")
                if base != integration_branch:
                    raise GitOpsError(
                        f"pr base branch {base!r} != integration branch "
                        f"{integration_branch!r} — refusing to merge; retarget "
                        f"the PR (gh pr edit --base {integration_branch}) and "
                        "re-enqueue"
                    )
            # GitHub keeps the native PR-merge API: it closes the PR in the UI,
            # squashes, and deletes the branch in one call. Byte-identical to
            # the pre-Option-B behavior.
            await self._run(
                "gh",
                "pr",
                "merge",
                pr_url,
                "--squash",
                "--delete-branch",
                *(["--match-head-commit", expected_head_sha] if expected_head_sha else []),
                cwd=workdir,
                env=env,
            )
            return

        # Option B — provider-agnostic plain-git merge for every non-github
        # host. No per-host PR-merge API is called, so this works on ANY git
        # server (GitLab, Gitea, Bitbucket, self-hosted, …). The executor has
        # already rebased pr_branch onto integration_branch and force-pushed it,
        # so integration is strictly behind the PR tip: a --ff-only merge is
        # guaranteed and produces no surprise merge commit. --ff-only is the
        # safety rail — if it is somehow NOT a fast-forward we fail loudly
        # rather than fabricate a merge commit (STOP-before-irreversible).
        #
        # Trade-off (chosen, see providers.md): the PR/MR is NOT closed on the
        # host's web UI — many hosts auto-detect the merge once the commits land
        # on the target branch; those that don't show a harmless stale-open PR.
        if not integration_branch or not pr_branch:
            raise GitOpsError(
                f"plain-git merge for forge {forge!r} requires both "
                f"integration_branch and pr_branch "
                f"(got integration_branch={integration_branch!r}, "
                f"pr_branch={pr_branch!r})"
            )
        # `checkout` cannot be argv-guarded: `--` makes the ref a pathspec and
        # `refs/heads/<b>` detaches HEAD, which would break the merge+push that
        # follow. Its guard is the branch validator at the schema layer —
        # `git checkout --orphan=x` is a live branch switch otherwise. `merge`
        # and `push` do accept `--`.
        await self._run(
            *self._git_with_identity("checkout", integration_branch),
            cwd=workdir,
            env=env,
        )
        await self._run(
            *self._git_with_identity("merge", "--ff-only", "--", pr_branch),
            cwd=workdir,
            env=env,
        )
        await self._run(
            *self._git_with_identity("push", "origin", "--", integration_branch),
            cwd=workdir,
            env=env,
        )

    def _git_with_identity(self, *args: str) -> tuple[str, ...]:
        """Return a `git` command prefixed with `-c user.name=… -c user.email=…`
        when an identity is configured, else plain `git`."""
        if self._git_identity is None:
            return ("git", *args)
        name, email = self._git_identity
        return (
            "git",
            "-c",
            f"user.name={name}",
            "-c",
            f"user.email={email}",
            *args,
        )

    async def _collect_unmerged_files(
        self, workdir: Path, *, env: dict[str, str] | None = None
    ) -> list[str]:
        rc, stdout, _stderr = await self._run_capture(
            "git", "status", "--porcelain=v1", cwd=workdir, env=env
        )
        if rc != 0:
            return []
        files: list[str] = []
        for line in stdout.splitlines():
            match = _UNMERGED_STATUS_PATTERN.match(line)
            if match is not None:
                files.append(match.group(1).strip())
        return files

    async def _run(
        self, *cmd: str, cwd: Path | None, env: dict[str, str] | None = None
    ) -> None:
        rc, _stdout, stderr = await self._run_capture(*cmd, cwd=cwd, env=env)
        if rc != 0:
            # Redact embedded PATs from cmd args + stderr — git/gh will echo
            # the full clone URL on auth failure, which lands in the merge
            # queue's `error_message` column otherwise.
            safe_args = " ".join(_redact_url_credentials(a) for a in cmd[1:])
            safe_stderr = _redact_url_credentials(stderr)
            raise GitOpsError(f"{cmd[0]} {safe_args} failed (rc={rc}): {safe_stderr}")

    async def _run_capture(
        self, *cmd: str, cwd: Path | None, env: dict[str, str] | None = None
    ) -> tuple[int, str, str]:
        # Merge parent env with overrides so PATH (etc.) is preserved while
        # secrets like GH_TOKEN flow through. Always pass an explicit env
        # rather than relying on inheritance — keeps the contract under test.
        # Per-call `env` (this entry's resolved credential) beats the
        # instance's overrides. The protocol pin goes on last: it must survive
        # a permissive ambient value and anything a caller passes in either.
        child_env = {
            **os.environ,
            **self._env_overrides,
            **(env or {}),
            "GIT_ALLOW_PROTOCOL": _GIT_ALLOWED_PROTOCOLS,
        }
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(cwd) if cwd is not None else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=child_env,
            )
        except FileNotFoundError:
            # A bare "[Errno 2] No such file or directory" named nothing and
            # cost a field diagnosis (backend image shipped without git/gh).
            raise GitOpsError(
                f"{cmd[0]}: binary not found on PATH — the backend image "
                "must ship the merge worker's prerequisites (git, gh)"
            )
        stdout_bytes, stderr_bytes = await process.communicate()
        return (
            process.returncode if process.returncode is not None else -1,
            stdout_bytes.decode("utf-8", errors="replace"),
            stderr_bytes.decode("utf-8", errors="replace"),
        )


# ---------------------------------------------------------------------------
# URL rewriting + executor factory (PAR-3-wiring)
# ---------------------------------------------------------------------------


# Forge -> the magic userinfo username used when embedding a token in an HTTPS
# clone URL. GitHub uses `x-access-token`; every other host (GitLab, Gitea,
# Forgejo, Bitbucket, self-hosted) uses `oauth2` — the GitLab-documented and
# Gitea-accepted universal form (token as the password). An unknown provider is
# treated as a generic non-github host, never silently given GitHub's form.
_GITHUB_USERINFO_USERNAME = "x-access-token"
_NONGITHUB_USERINFO_USERNAME = "oauth2"


def _userinfo_username_for_provider(provider: str) -> str:
    return (
        _GITHUB_USERINFO_USERNAME
        if provider == "github"
        else _NONGITHUB_USERINFO_USERNAME
    )


def _rewrite_url_with_token(
    url: str, token: str, *, username: str = _GITHUB_USERINFO_USERNAME
) -> str:
    """Embed a forge access token into an HTTPS clone URL.

    Convention: `https://host/org/repo.git` becomes
    `https://<username>:<token>@host/org/repo.git`. `username` defaults to
    GitHub's `x-access-token` (so the github path stays byte-identical);
    callers pass `oauth2` for GitLab/Gitea. SSH URLs (`git@host:org/repo.git`)
    pass through unchanged — SSH auth uses the runner's key, not the platform
    token. Empty token returns input unchanged so dev-mode (no token set) keeps
    working against public repos.

    If the URL already carries credentials (e.g. a previous rewrite), the
    entire userinfo segment (username included) is replaced rather than stacked.
    """
    if not token:
        return url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return url
    if parts.hostname is None:
        return url
    netloc = f"{username}:{token}@{parts.hostname}"
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


# Re-exported: git/gh echo URLs in error stderr verbatim and the embedded PAT
# must never reach DB-stored `error_message` fields. The implementation lives
# in the git package so git_connection.py can redact last_error without
# importing a merge service.
_redact_url_credentials = redact_url_credentials


def _url_only_credential_resolver(
    resolve_repo_url: Callable[[MergeQueueEntry], Awaitable[str]],
) -> Callable[[MergeQueueEntry], Awaitable[EntryCredential]]:
    """Adapt a URL-only resolver to the credential seam.

    The URL is whatever the caller says it is (already authenticated, or
    deliberately not), and there is no credential to attribute a failure to or
    to mark unhealthy.
    """

    async def _resolve(entry: MergeQueueEntry) -> EntryCredential:
        return EntryCredential(
            url=await resolve_repo_url(entry),
            credential=None,
            resolution=CredentialResolution(credential=None),
        )

    return _resolve


def make_merge_executor(*, session_factory, settings) -> MergeExecutor:
    """Build a production-ready `MergeExecutor` wired to DB + git tooling.

    `session_factory` is the project's `async_session` (from
    `app.database`) — a callable returning an async context manager that
    yields an `AsyncSession`. Building the executor once at app startup
    (rather than per-tick) keeps the closure stable across loop
    iterations and avoids re-reading settings on every tick.
    """
    # Boot-time visibility, not a hard failure: the API serves fine without
    # these binaries, but every merge attempt will fail (field report
    # 2026-08-08 — the image shipped bare and each entry churned to give-up).
    for binary in ("git", "gh"):
        if shutil.which(binary) is None:
            logging.getLogger(__name__).warning(
                "merge executor: %r not found on PATH — every merge attempt "
                "will fail until the backend image ships it",
                binary,
            )

    async def _resolve_credential(entry: MergeQueueEntry) -> EntryCredential:
        """Resolve THIS entry's repo to the credential allowed to act on it.

        Per-entry rather than per-worker: the repo's workspace may own a
        credential the platform doesn't have (a self-hosted forge), and the
        platform may own one this repo's host never issued. The resolver
        host-checks every branch, so what comes back is safe to embed in the
        clone URL.
        """
        async with session_factory() as session:
            repo = (
                await session.execute(
                    select(GitRepo).where(GitRepo.id == entry.repo_id)
                )
            ).scalar_one()
            resolution = await CredentialResolver(session).resolve(repo)
            # Read inside the session: attributes expire on close, and a lazy
            # refresh outside the async context raises MissingGreenlet.
            repo_url = repo.url

        credential = resolution.credential
        url = (
            _rewrite_url_with_token(
                repo_url, credential.token, username=credential.username
            )
            if credential is not None
            else repo_url
        )
        if credential is None:
            logger.info(
                "merge executor: no credential for repo %s (%s) — attempting "
                "unauthenticated: %s",
                entry.repo_id,
                resolution.reason.value if resolution.reason else "unknown",
                resolution.detail,
            )
        return EntryCredential(url=url, credential=credential, resolution=resolution)

    async def _record_auth_failure(connection_id: uuid.UUID, message: str) -> None:
        """Mark the connection unhealthy so the operator sees WHY the queue is
        stuck on the connections list, without re-probing."""
        async with session_factory() as session:
            async with session.begin():
                await _connection_service(session).record_auth_failure(
                    connection_id, message
                )

    async def _record_auth_success(connection_id: uuid.UUID) -> None:
        async with session_factory() as session:
            async with session.begin():
                await _connection_service(session).record_auth_success(connection_id)

    async def _resolve_forge(entry: MergeQueueEntry) -> str:
        async with session_factory() as session:
            result = await session.execute(
                select(GitRepo.provider).where(GitRepo.id == entry.repo_id)
            )
            provider = result.scalar_one()
        # provider is a GitProvider enum (str subclass) — normalize to its value.
        return getattr(provider, "value", str(provider))

    async def _check_ci(entry: MergeQueueEntry) -> str:
        # GitHub-only read (check runs + combined status; plan-agnostic).
        # Other forges return "none" — fail-open like a repo with no CI,
        # matching the is_github_pr_url discipline of the done-gate and the
        # reconciler. Mirrors the scheduler's _github_client_factory shape so
        # the future GitHostProvider abstraction (d8f7eba4 L2) can swap this
        # consumer in the same move.
        from app.services import github_client as github_client_module

        if not require_ci_green and await _resolve_completion(entry) is None:
            return "none"

        if not github_client_module.is_github_pr_url(entry.pr_url):
            return "none"
        # The entry's OWN credential, not the platform's: with the global token
        # the gate reads a repo the platform may not see at all, and this gate
        # fails CLOSED — a tenant whose own token would have worked gets a
        # permanently wedged queue instead.
        resolved = await _resolve_credential(entry)
        client = github_client_module.GitHubClient(
            token=resolved.credential.token if resolved.credential else "",
            base_url=getattr(settings, "GITHUB_API_URL", "https://api.github.com"),
        )
        completion = await _resolve_completion(entry)
        return await client.get_pr_ci_state(entry.pr_url, **({"expected_head_sha": completion["source_sha"]} if completion else {}))

    async def _resolve_merge_gate(entry: MergeQueueEntry) -> str:
        async with session_factory() as session:
            return await resolve_board_merge_gate(session, entry.repo_id)

    async def _resolve_completion(entry: MergeQueueEntry) -> dict | None:
        from app.repositories.merge_queue import MergeQueueRepository
        from app.services.completion import CompletionService
        from app.services.completion_policy import CompletionPolicyService

        async with session_factory() as session:
            scope = await MergeQueueRepository(session).enqueue_scope(entry.card_id, entry.repo_id, entry.workspace_id)
            if scope is None:
                raise GitOpsError("Merge queue source no longer belongs to this workspace")
            card, board, repo = scope
            policy = await CompletionPolicyService(session).effective_policy(board)
            if policy is None:
                return None
            candidate = await CompletionService(session).current_candidate(board, card, refresh=False)
            if (candidate is None or not candidate.review_passed
                    or candidate.status != "awaiting_merge"
                    or candidate.pr_url != entry.pr_url or candidate.branch != entry.pr_branch
                    or candidate.target_branch != entry.integration_branch or candidate.repo_id != repo.id
                    or policy.landing_actor == "human" or "merge_queue" not in policy.landing_methods):
                raise GitOpsError("Current completion approval is required for this exact source")
            return {"source_sha": candidate.source_sha, "require_forge_checks": policy.require_forge_checks}

    # Kill switch, mirroring MERGE_QUEUE_TICK_SECONDS' env pattern: ON by
    # default (a red or pending CI blocks the merge, fail-open when the repo
    # has no CI at all), off with MERGE_REQUIRE_CI_GREEN=false.
    require_ci_green = os.environ.get("MERGE_REQUIRE_CI_GREEN", "true").lower() not in (
        "false",
        "0",
        "no",
    )

    # No GH_TOKEN here: credentials are per-entry now, and one executor serves
    # every workspace. A constructor-baked token would be exactly the global
    # token this seam exists to remove.
    git_ops = SubprocessGitOps(
        git_identity=(settings.GIT_USER_NAME, settings.GIT_USER_EMAIL),
    )
    return MergeExecutor(
        git_ops=git_ops,
        resolve_credential=_resolve_credential,
        resolve_forge=_resolve_forge,
        check_ci=_check_ci,
        resolve_merge_gate=_resolve_merge_gate,
        resolve_completion=_resolve_completion,
        on_auth_failure=_record_auth_failure,
        on_auth_success=_record_auth_success,
    )
