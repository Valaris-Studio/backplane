# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest

from app.core.repo_url import normalize_repo_url


@pytest.mark.parametrize(
    "url",
    [
        "git@GitHub.com:Valaris-Studio/backplane.git",
        "git@github.com:Valaris-Studio/backplane",
        "https://github.com/Valaris-Studio/backplane.git",
        "https://github.com/Valaris-Studio/backplane/",
        "http://GITHUB.COM/Valaris-Studio/backplane",
        "https://x-access-token:secret@github.com/Valaris-Studio/backplane.git",
        "ssh://git@github.com/Valaris-Studio/backplane",
        "ssh://git@github.com:22/Valaris-Studio/backplane.git",
        "  git@github.com:Valaris-Studio/backplane.git\n",
    ],
)
def test_equivalent_remote_spellings_normalize_to_one_key(url):
    assert normalize_repo_url(url) == "github.com/valaris-studio/backplane"


@pytest.mark.parametrize(
    "url",
    [
        "git@github.com:Org/Repo.git",
        "https://github.com/org/repo",
        "ssh://git@github.com:22/org/repo",
    ],
)
def test_contract_examples(url):
    assert normalize_repo_url(url) == "github.com/org/repo"


def test_nested_groups_are_kept():
    assert (
        normalize_repo_url("git@gitlab.example.com:Group/Sub/Repo.git")
        == "gitlab.example.com/group/sub/repo"
    )


@pytest.mark.parametrize(
    "url",
    [
        "",
        "not a url",
        "/local/path/repo",
        "file:///tmp/repo",
        "https://github.com/",
        None,
    ],
)
def test_unrecognizable_urls_normalize_to_none(url):
    assert normalize_repo_url(url) is None
