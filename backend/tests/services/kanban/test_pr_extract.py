# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.services.kanban.pr_extract import extract_pr_branch, extract_pr_url


def test_extract_pr_url_from_structured_block():
    desc = "Do the thing.\n\n---\nBranch: feat/foo\nPR: https://github.com/owner/repo/pull/42\n"
    assert extract_pr_url(desc) == "https://github.com/owner/repo/pull/42"


def test_extract_pr_url_with_multiple_blocks_returns_first():
    desc = (
        "body\n---\nBranch: a\nPR: https://github.com/o/r/pull/1\n"
        "---\nBranch: b\nPR: https://github.com/o/r/pull/2\n"
    )
    assert extract_pr_url(desc) == "https://github.com/o/r/pull/1"


def test_extract_pr_url_fallback_inline_github_url():
    desc = "see https://github.com/o/r/pull/7 for details"
    assert extract_pr_url(desc) == "https://github.com/o/r/pull/7"


def test_extract_pr_url_empty_description():
    assert extract_pr_url("") == ""
    assert extract_pr_url("   \n\n  ") == ""


def test_extract_pr_url_no_pr_returns_empty():
    assert extract_pr_url("just a description with no PR reference") == ""


def test_extract_pr_branch_from_structured_block():
    desc = "---\nBranch: feat/login\nPR: https://github.com/o/r/pull/5\n"
    assert extract_pr_branch(desc) == "feat/login"


def test_extract_pr_branch_missing_returns_empty():
    assert extract_pr_branch("no branch info here") == ""
    assert extract_pr_branch("") == ""
