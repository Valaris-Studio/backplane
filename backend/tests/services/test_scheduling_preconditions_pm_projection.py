# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Legacy description scanners must survive PM-JSON card descriptions.

Editor P0-3 normalizes card descriptions to canonical ProseMirror JSON at
write time. The scheduling preconditions still scan the raw description
string for the legacy `Branch:` block and PR URLs — against a PM-JSON
description the line-based `Branch:` scan silently dies (the whole doc is
one JSON line), which would strand every runner card in the M1-05 limbo
the description fallback exists to cure.

The contract: the scanners project the PM doc back to text before scanning,
and the projection degrades to a no-op on non-PM (legacy raw) strings.

The reconciler's `extract_pr_url` (services/kanban/pr_extract.py, used at
reconciler.scan_once) and `_text_has_pr_url` (shared with
assignment_service._card_has_pr_url) are pinned at their existing pure-
function seams, matching tests/services/kanban/test_pr_extract.py.
"""

from app.models.kanban.card import Card
from app.services.kanban.pr_extract import extract_pr_url
from app.services.notes.content_normalizer import normalize_note_content
from app.services.scheduling.preconditions import (
    _extract_card_branch,
    _extract_card_pr_url,
    _text_has_pr_url,
)


PR_URL = "https://github.com/o/r/pull/42"

RAW_DESC = f"Done.\n\nBranch: feature/x\nPR: {PR_URL}"

PM_DESC = normalize_note_content(RAW_DESC)


def test_extract_card_branch_from_pm_json_description():
    card = Card(branch_name=None, description=PM_DESC)
    assert _extract_card_branch(card) == "feature/x"


def test_extract_card_pr_url_from_pm_json_description():
    card = Card(branch_name=None, pr_url=None, description=PM_DESC)
    assert _extract_card_pr_url(card) == PR_URL


def test_extract_card_branch_from_raw_markdown_unchanged():
    """The projection is a no-op on legacy raw-markdown descriptions."""
    card = Card(branch_name=None, description=RAW_DESC)
    assert _extract_card_branch(card) == "feature/x"


def test_extract_card_pr_url_from_raw_markdown_unchanged():
    card = Card(branch_name=None, pr_url=None, description=RAW_DESC)
    assert _extract_card_pr_url(card) == PR_URL


def test_text_has_pr_url_sees_pr_in_pm_json_description():
    """assignment_service._card_has_pr_url delegates here (the require_pr_url
    discover filter's description scan) — it must keep recognizing the PR
    once descriptions are PM JSON."""
    assert _text_has_pr_url(PM_DESC) is True


def test_reconciler_extract_pr_url_from_pm_json_description():
    """reconciler.scan_once falls back to extract_pr_url(card.description)
    for cards predating the pr_url column — that fallback must keep finding
    the PR in a PM-JSON description."""
    assert extract_pr_url(PM_DESC) == PR_URL
