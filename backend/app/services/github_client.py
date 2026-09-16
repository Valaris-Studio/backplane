# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# LAYER: legacy single-tenant git path (one global GITHUB_TOKEN env var).
# The new provider-agnostic OAuth path lives in app/integrations/git/.
# Done-gate (scheduling/preconditions.py) + card service still call into
# this module; migrate one caller at a time once OAuth ships in Sprint 2.
import asyncio
import re
from dataclasses import dataclass

import httpx

from app.exceptions import BadGatewayError, ResourceNotFoundError


class ForgeAuthError(BadGatewayError):
    """The forge rejected the credential (401/403).

    Distinct from a transient failure because it is actionable: the operator
    must fix or rotate a specific credential, and consumers record it against
    the connection that produced it. Subclasses BadGatewayError so every
    existing `except BadGatewayError` soft-pass keeps working unchanged — an
    unusable credential must not become a hard failure at a seam that used to
    tolerate an unreachable GitHub.
    """


_PR_URL = re.compile(r"^https://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)/?$")
_REPO_URL = re.compile(r"^https://github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")


def is_github_pr_url(pr_url: str | None) -> bool:
    """True iff `pr_url` is a GitHub PR url this client can fetch a status for.

    The single source of truth for "GitHubClient.get_pr_status can parse this" —
    callers gate on this BEFORE calling get_pr_status so a non-GitHub forge url
    (Gitea/GitLab) never reaches `_PR_URL` and raises ValueError. Shared by the
    Done-gate (card.py) to soft-pass non-GitHub forges instead of crashing the
    move (cell #12, sibling of the scheduler's provider-agnostic cell #11)."""
    return bool(pr_url) and bool(_PR_URL.match(pr_url))


def is_github_repo_url(repo_url: str | None) -> bool:
    return bool(repo_url) and bool(_REPO_URL.fullmatch(repo_url))

# Bounded retry for transient GitHub blips. The Done-gate calls
# get_pr_status synchronously inside a card-move; without retry, a
# single 502 leaves the card stuck in In-Review and the runner
# re-claims it on every poll cycle (smoke test 2026-04-24).
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFFS_S = (0.5, 1.0)


@dataclass(frozen=True)
class PRStatus:
    merged: bool
    mergeable: bool | None
    state: str
    # Head commit SHA — the ref CI checks attach to. None on payloads that
    # omit "head" (defensive; the REST PR object always carries it).
    head_sha: str | None = None
    merge_commit_sha: str | None = None
    head_branch: str | None = None
    base_branch: str | None = None
    base_repo_url: str | None = None
    checks_passed: bool | None = None


@dataclass(frozen=True)
class OpenPR:
    number: int
    head_branch: str
    url: str


class GitHubClient:
    def __init__(
        self,
        token: str,
        base_url: str = "https://api.github.com",
        transport: httpx.BaseTransport | None = None,
    ):
        self._token = token
        self._base_url = base_url
        self._transport = transport

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        raise_on_auth_error: bool = True,
    ) -> httpx.Response:
        """Perform a GET against `path`, retrying transient transport errors and 5xx.

        Retries are non-blocking and bounded — see _RETRY_ATTEMPTS / _RETRY_BACKOFFS_S.
        4xx responses are returned to the caller without retry; the caller
        is responsible for mapping them (404 -> not found, etc.).
        """
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        last_exc: Exception | None = None
        async with httpx.AsyncClient(
            base_url=self._base_url,
            transport=self._transport,
            timeout=5,
            headers=headers,
        ) as client:
            for attempt in range(_RETRY_ATTEMPTS):
                try:
                    response = await client.request(method, path, params=params)
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last_exc = exc
                else:
                    if response.status_code < 500:
                        if (
                            raise_on_auth_error
                            and response.status_code in (401, 403)
                        ):
                            # Named rather than left to fail later on a missing
                            # JSON key: a rejected credential is the one 4xx an
                            # operator can actually fix, and consumers record
                            # it against the connection that produced it.
                            raise ForgeAuthError(
                                f"GitHub rejected the credential "
                                f"(HTTP {response.status_code}) for {path}",
                                error_code="forge_auth_failed",
                            )
                        return response
                    last_exc = None
                if attempt < _RETRY_ATTEMPTS - 1:
                    await asyncio.sleep(_RETRY_BACKOFFS_S[attempt])
        raise BadGatewayError(
            "GitHub unreachable", error_code="github_unavailable"
        ) from last_exc

    async def get_repository_access(self, repo_url: str) -> None:
        """Verify repository metadata using this client's resolved credential."""
        match = _REPO_URL.fullmatch(repo_url)
        if match is None:
            raise ValueError("Unsupported repository URL")
        owner, repo = match.groups()
        response = await self._request("GET", f"/repos/{owner}/{repo}")
        if response.status_code == 404:
            raise ResourceNotFoundError("Repo not found", error_code="repo_not_found")
        if response.status_code != 200:
            raise BadGatewayError("GitHub repository read failed", error_code="github_unavailable")
        data = response.json()
        if not isinstance(data, dict) or str(data.get("full_name", "")).lower() != f"{owner}/{repo}".lower():
            raise ValueError("Repository metadata identity missing or inconsistent")

    async def get_pr_status(self, pr_url: str) -> PRStatus:
        m = _PR_URL.match(pr_url)
        if not m:
            raise ValueError(f"not a github pr url: {pr_url!r}")
        owner, repo, number = m.group(1), m.group(2), m.group(3)

        response = await self._request("GET", f"/repos/{owner}/{repo}/pulls/{number}")

        if response.status_code == 404:
            raise ResourceNotFoundError("PR not found", error_code="pr_not_found")
        if response.status_code != 200:
            raise BadGatewayError("GitHub pull request read failed", error_code="github_unavailable")

        data = response.json()
        return PRStatus(
            merged=bool(data["merged"]),
            mergeable=data.get("mergeable"),
            state=data["state"],
            head_sha=(data.get("head") or {}).get("sha"),
            merge_commit_sha=data.get("merge_commit_sha"),
            head_branch=(data.get("head") or {}).get("ref"),
            base_branch=(data.get("base") or {}).get("ref"),
            base_repo_url=((data.get("base") or {}).get("repo") or {}).get("html_url"),
        )

    async def get_pr_ci_state(self, pr_url: str, *, expected_head_sha: str | None = None) -> str:
        """Combined CI verdict for a PR's head commit: "green" | "pending" |
        "red" | "none" (card 51810501, require_ci_green).

        Reads BOTH the check-runs API (GitHub Actions and modern apps) and the
        legacy combined-status API (third-party CI posting commit statuses) —
        either surface can veto. "none" means neither surface has anything
        recorded, the fail-open input for repos without CI. Plan-agnostic:
        these are plain reads, no branch protection required.
        """
        m = _PR_URL.match(pr_url)
        if not m:
            raise ValueError(f"not a github pr url: {pr_url!r}")
        owner, repo = m.group(1), m.group(2)

        status = await self.get_pr_status(pr_url)
        if expected_head_sha is not None and status.head_sha != expected_head_sha:
            return "pending"
        if not status.head_sha:
            return "none"

        # A 403 here is STRUCTURAL, not a bad credential: the Checks API is
        # Apps-only, so every fine-grained PAT gets one. It must fall through
        # to the Actions read below rather than raise ForgeAuthError.
        runs_path = f"/repos/{owner}/{repo}/commits/{status.head_sha}/check-runs"
        runs_params = {"per_page": 100}
        runs_resp = await self._request(
            "GET",
            runs_path,
            params=runs_params,
            raise_on_auth_error=False,
        )
        if runs_resp.status_code == 403:
            # Structural, not transient: fine-grained PATs cannot read the
            # Checks API at all (Apps-only permission), which hides GitHub
            # Actions CI. The Actions workflow-runs API carries the same
            # verdict and IS grantable (Actions: read) — map its runs onto
            # the check-run vocabulary. If that read fails too, fall through
            # to the unreadable path (the token can't see CI either way).
            runs_path = f"/repos/{owner}/{repo}/actions/runs"
            runs_params = {"head_sha": status.head_sha, "per_page": 100}
            runs_resp = await self._request(
                "GET",
                runs_path,
                params=runs_params,
            )
            runs_key = "workflow_runs"
        else:
            runs_key = "check_runs"
        runs = []
        for page in range(1, 11):
            if runs_resp.status_code >= 400:
                raise BadGatewayError("GitHub check reads failed", error_code="github_unavailable")
            data = runs_resp.json()
            batch = data.get(runs_key)
            if not isinstance(batch, list):
                return "pending"  # An incomplete read is not a successful check.
            runs.extend(batch)
            more = "next" in runs_resp.links or data.get("total_count", len(runs)) > len(runs)
            if not more:
                break
            if page == 10 or not batch:
                return "pending"
            runs_resp = await self._request("GET", runs_path, params={**runs_params, "page": page + 1})
        status_resp = await self._request(
            "GET", f"/repos/{owner}/{repo}/commits/{status.head_sha}/status"
        )
        if runs_resp.status_code >= 400 or status_resp.status_code >= 400:
            raise BadGatewayError(
                "GitHub check reads failed", error_code="github_unavailable"
            )
        combined = status_resp.json()

        # startup_failure is workflow-run-only; waiting/requested/pending are
        # workflow-run statuses — harmless supersets for check runs.
        red_conclusions = {
            "failure", "cancelled", "timed_out", "action_required",
            "startup_failure", "stale",
        }
        red = any(r.get("conclusion") in red_conclusions for r in runs)
        pending = any(
            r.get("status") != "completed" or r.get("conclusion") not in (red_conclusions | {"success", "neutral", "skipped"})
            for r in runs
        )

        statuses = combined.get("statuses") or []
        if statuses:
            if combined.get("state") == "failure":
                red = True
            elif combined.get("state") != "success":
                pending = True

        if red:
            return "red"
        if pending:
            return "pending"
        if runs or statuses:
            return "green"
        return "none"

    async def list_open_prs(self, repo_url: str) -> list[OpenPR]:
        """Return the open PRs for `repo_url` (state=open).

        Only the fields the scheduler needs are returned (number, head
        branch, html_url). GitHub paginates at 30; we ask for 100 since
        a single repo with that many open PRs already indicates a
        backlog the scheduler cannot reason about.
        """
        m = _REPO_URL.match(repo_url)
        if not m:
            raise ValueError(f"not a github repo url: {repo_url!r}")
        owner, repo = m.group(1), m.group(2)

        response = await self._request(
            "GET",
            f"/repos/{owner}/{repo}/pulls",
            params={"state": "open", "per_page": 100},
        )

        if response.status_code == 404:
            raise ResourceNotFoundError("Repo not found", error_code="repo_not_found")
        if response.status_code != 200:
            raise BadGatewayError("GitHub pull request list failed", error_code="github_unavailable")

        out: list[OpenPR] = []
        data = response.json()
        if not isinstance(data, list):
            raise ValueError("Pull request list missing")
        for pr in data:
            head = pr.get("head") or {}
            out.append(
                OpenPR(
                    number=int(pr["number"]),
                    head_branch=str(head.get("ref", "")),
                    url=str(pr.get("html_url", "")),
                )
            )
        return out
