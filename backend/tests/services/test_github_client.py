# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import httpx
import pytest

from app.exceptions import BadGatewayError, ResourceNotFoundError
from app.services.github_client import GitHubClient, PRStatus


def _transport(handler):
    return httpx.MockTransport(handler)


async def test_pr_status_preserves_exact_landing_provenance():
    payload = {"merged": True, "mergeable": True, "state": "closed",
               "merge_commit_sha": "b" * 40,
               "head": {"sha": "a" * 40, "ref": "feature/change"},
               "base": {"ref": "main", "repo": {"html_url": "https://github.com/foo/bar"}}}
    client = GitHubClient(token="fixture", transport=_transport(lambda request: httpx.Response(200, json=payload)))
    observed = await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert observed.merge_commit_sha == "b" * 40
    assert observed.head_sha == "a" * 40
    assert observed.head_branch == "feature/change"
    assert observed.base_branch == "main"
    assert observed.base_repo_url == "https://github.com/foo/bar"


async def test_github_client_parses_pr_url_owner_repo_number():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        return httpx.Response(200, json={"merged": True, "mergeable": True, "state": "closed"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert captured["path"] == "/repos/foo/bar/pulls/42"


async def test_github_client_returns_merged_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"merged": True, "mergeable": True, "state": "closed"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    status = await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert isinstance(status, PRStatus)
    assert status.merged is True
    assert status.mergeable is True
    assert status.state == "closed"


async def test_github_client_returns_unmerged_mergeable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"merged": False, "mergeable": True, "state": "open"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    status = await client.get_pr_status("https://github.com/foo/bar/pull/9")
    assert status.merged is False
    assert status.mergeable is True
    assert status.state == "open"


async def test_github_client_returns_unmerged_unmergeable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"merged": False, "mergeable": False, "state": "open"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    status = await client.get_pr_status("https://github.com/foo/bar/pull/9")
    assert status.merged is False
    assert status.mergeable is False
    assert status.state == "open"


async def test_github_client_raises_not_found_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "Not Found"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    with pytest.raises(ResourceNotFoundError) as exc_info:
        await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert exc_info.value.error_code == "pr_not_found"


async def test_github_client_raises_bad_gateway_on_500():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = GitHubClient(token="tok", transport=_transport(handler))
    with pytest.raises(BadGatewayError) as exc_info:
        await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert exc_info.value.error_code == "github_unavailable"


async def test_github_client_raises_bad_gateway_on_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    client = GitHubClient(token="tok", transport=_transport(handler))
    with pytest.raises(BadGatewayError) as exc_info:
        await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert exc_info.value.error_code == "github_unavailable"


async def test_github_client_sends_auth_header():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"merged": True, "mergeable": True, "state": "closed"})

    client = GitHubClient(token="secrettok", transport=_transport(handler))
    await client.get_pr_status("https://github.com/foo/bar/pull/1")
    assert captured["auth"] == "Bearer secrettok"


async def test_github_client_invalid_pr_url_raises_value_error():
    client = GitHubClient(token="tok")
    with pytest.raises(ValueError):
        await client.get_pr_status("https://example.com/foo")


# is_github_pr_url is the single source of truth for "get_pr_status can fetch
# this" — callers (the Done-gate) gate on it so a non-GitHub forge url never
# reaches get_pr_status and raises ValueError (cell #12). The exact-match
# contract here must stay in lock-step with the _PR_URL regex get_pr_status uses.
@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://github.com/acme/widget/pull/9", True),
        ("https://github.com/acme/widget/pull/9/", True),
        # Non-GitHub forges: must be rejected so the gate soft-passes them.
        ("https://gitea.example.com/acme/widget/pulls/9", False),
        ("https://gitlab.example.com/acme/widget/-/merge_requests/9", False),
        # github.com/.../pulls/N (plural) is NOT a real GitHub PR url (the typo
        # cell #11's strictness test also guards) — must be rejected.
        ("https://github.com/acme/widget/pulls/9", False),
        ("https://example.com/foo", False),
        ("", False),
        (None, False),
    ],
)
def test_is_github_pr_url(url, expected):
    from app.services.github_client import is_github_pr_url

    assert is_github_pr_url(url) is expected


async def test_github_client_retries_pr_status_after_transient_5xx():
    """Regression for stuck-card review-loop on 2026-04-24 smoke test.

    A single transient GitHub 502 was leaving cards in In-Review forever
    because the Done-gate fail-fasts on first error. Bounded retry covers
    the common transient case."""
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) < 3:
            return httpx.Response(502, text="upstream blip")
        return httpx.Response(200, json={"merged": True, "mergeable": True, "state": "closed"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    status = await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert status.merged is True
    assert len(attempts) == 3


async def test_github_client_retries_pr_status_after_transient_timeout():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) < 2:
            raise httpx.ConnectTimeout("slow")
        return httpx.Response(200, json={"merged": False, "mergeable": True, "state": "open"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    status = await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert status.merged is False
    assert len(attempts) == 2


async def test_github_client_gives_up_after_persistent_5xx():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(503, text="down")

    client = GitHubClient(token="tok", transport=_transport(handler))
    with pytest.raises(BadGatewayError) as exc_info:
        await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert exc_info.value.error_code == "github_unavailable"
    assert len(attempts) == 3


async def test_github_client_does_not_retry_4xx():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(404, json={"message": "Not Found"})

    client = GitHubClient(token="tok", transport=_transport(handler))
    with pytest.raises(ResourceNotFoundError):
        await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert len(attempts) == 1


async def test_github_client_retries_list_open_prs_after_transient_5xx():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) < 2:
            return httpx.Response(502, text="blip")
        return httpx.Response(200, json=[
            {"number": 1, "head": {"ref": "feat/x"}, "html_url": "https://github.com/foo/bar/pull/1"},
        ])

    client = GitHubClient(token="tok", transport=_transport(handler))
    prs = await client.list_open_prs("https://github.com/foo/bar")
    assert len(prs) == 1
    assert prs[0].number == 1
    assert len(attempts) == 2


# --- PR CI state (card 51810501: require_ci_green in the merge executor) ----
#
# Tri-state + none: "green" (every check concluded acceptably), "pending"
# (anything still running), "red" (any failure-class conclusion), "none"
# (repo has no check runs AND no commit statuses — the fail-open input for
# require_ci_present=False).


def _ci_transport(
    pr_json=None,
    check_runs_json=None,
    status_json=None,
    check_runs_status_code=200,
    workflow_runs_json=None,
    workflow_runs_status_code=200,
):
    pr_json = pr_json or {
        "merged": False,
        "mergeable": True,
        "state": "open",
        "head": {"sha": "abc123"},
    }
    check_runs_json = (
        check_runs_json
        if check_runs_json is not None
        else {"total_count": 0, "check_runs": []}
    )
    status_json = (
        status_json
        if status_json is not None
        else {"state": "pending", "statuses": []}
    )
    workflow_runs_json = (
        workflow_runs_json
        if workflow_runs_json is not None
        else {"total_count": 0, "workflow_runs": []}
    )

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/pulls/" in path:
            return httpx.Response(200, json=pr_json)
        if path.endswith("/check-runs"):
            return httpx.Response(check_runs_status_code, json=check_runs_json)
        if path.endswith("/actions/runs"):
            return httpx.Response(
                workflow_runs_status_code, json=workflow_runs_json
            )
        if path.endswith("/status"):
            return httpx.Response(200, json=status_json)
        return httpx.Response(404, json={"message": "unexpected path " + path})

    return _transport(handler)


def _run(name, status, conclusion=None):
    return {"name": name, "status": status, "conclusion": conclusion}


async def test_pr_status_carries_head_sha():
    client = GitHubClient(token="tok", transport=_ci_transport())
    status = await client.get_pr_status("https://github.com/foo/bar/pull/42")
    assert status.head_sha == "abc123"


async def test_ci_state_green_when_all_check_runs_succeed():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            check_runs_json={
                "total_count": 2,
                "check_runs": [
                    _run("ci", "completed", "success"),
                    _run("lint", "completed", "skipped"),
                ],
            }
        ),
    )
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "green"


async def test_ci_state_red_on_any_failure_conclusion():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            check_runs_json={
                "total_count": 2,
                "check_runs": [
                    _run("ci", "completed", "success"),
                    _run("test", "completed", "failure"),
                ],
            }
        ),
    )
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "red"


async def test_ci_state_pending_when_any_run_in_progress():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            check_runs_json={
                "total_count": 2,
                "check_runs": [
                    _run("ci", "completed", "success"),
                    _run("test", "in_progress"),
                ],
            }
        ),
    )
    assert (
        await client.get_pr_ci_state("https://github.com/foo/bar/pull/42")
        == "pending"
    )


async def test_ci_state_red_on_failed_legacy_commit_status():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            status_json={
                "state": "failure",
                "statuses": [{"context": "jenkins", "state": "failure"}],
            }
        ),
    )
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "red"


async def test_ci_state_pending_on_pending_legacy_commit_status():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            status_json={
                "state": "pending",
                "statuses": [{"context": "jenkins", "state": "pending"}],
            }
        ),
    )
    assert (
        await client.get_pr_ci_state("https://github.com/foo/bar/pull/42")
        == "pending"
    )


async def test_ci_state_none_when_no_checks_and_no_statuses():
    client = GitHubClient(token="tok", transport=_ci_transport())
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "none"


async def test_ci_state_timed_out_and_cancelled_are_red():
    for conclusion in ("timed_out", "cancelled", "action_required"):
        client = GitHubClient(
            token="tok",
            transport=_ci_transport(
                check_runs_json={
                    "total_count": 1,
                    "check_runs": [_run("ci", "completed", conclusion)],
                }
            ),
        )
        state = await client.get_pr_ci_state("https://github.com/foo/bar/pull/42")
        assert state == "red", f"conclusion {conclusion} must be red, got {state}"


# Fine-grained PATs cannot read the Checks API at all — GitHub grants that
# permission to Apps only, so check-runs 403s structurally and GitHub Actions
# CI becomes invisible (field run, 2026-08-08: every entry churned
# "ci state unreadable"). The Actions workflow-runs API reports the same
# verdict and IS grantable (Actions: read) — a 403 on check-runs falls back
# to it. Any other check-runs error stays BadGateway (transient, retry).


def _wf_run(status, conclusion=None):
    return {"name": "ci", "status": status, "conclusion": conclusion}


async def test_ci_state_checks_forbidden_falls_back_to_actions_green():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            check_runs_status_code=403,
            workflow_runs_json={
                "total_count": 2,
                "workflow_runs": [
                    _wf_run("completed", "success"),
                    _wf_run("completed", "skipped"),
                ],
            },
        ),
    )
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "green"


async def test_ci_state_checks_forbidden_fallback_red_and_pending():
    for runs, expected in (
        ([_wf_run("completed", "failure")], "red"),
        ([_wf_run("completed", "startup_failure")], "red"),
        ([_wf_run("in_progress")], "pending"),
        ([_wf_run("waiting")], "pending"),
    ):
        client = GitHubClient(
            token="tok",
            transport=_ci_transport(
                check_runs_status_code=403,
                workflow_runs_json={
                    "total_count": len(runs),
                    "workflow_runs": runs,
                },
            ),
        )
        state = await client.get_pr_ci_state("https://github.com/foo/bar/pull/42")
        assert state == expected, f"runs {runs} must be {expected}, got {state}"


async def test_ci_state_checks_forbidden_no_runs_no_statuses_is_none():
    client = GitHubClient(
        token="tok", transport=_ci_transport(check_runs_status_code=403)
    )
    assert await client.get_pr_ci_state("https://github.com/foo/bar/pull/42") == "none"


async def test_ci_state_unreadable_when_actions_fallback_also_forbidden():
    client = GitHubClient(
        token="tok",
        transport=_ci_transport(
            check_runs_status_code=403, workflow_runs_status_code=403
        ),
    )
    with pytest.raises(BadGatewayError):
        await client.get_pr_ci_state("https://github.com/foo/bar/pull/42")


async def test_repository_access_probes_exact_metadata_with_supplied_credential():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"full_name": "foo/bar"})

    client = GitHubClient(token="bound-workspace-fixture", transport=_transport(handler))
    await client.get_repository_access("https://github.com/foo/bar.git")
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].url.path == "/repos/foo/bar"
    assert requests[0].headers["authorization"] == "Bearer bound-workspace-fixture"


@pytest.mark.parametrize("payload", [{}, {"full_name": "another/repo"}, [], {"full_name": None}])
async def test_repository_access_rejects_incomplete_or_wrong_identity(payload):
    client = GitHubClient(token="fixture", transport=_transport(lambda request: httpx.Response(200, json=payload)))
    with pytest.raises(ValueError):
        await client.get_repository_access("https://github.com/foo/bar")
