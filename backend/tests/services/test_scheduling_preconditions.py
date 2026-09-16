# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the repo_has_no_open_pr scheduling precondition.

The evaluator must recognize a card's OWN open PR as its own (so a card waiting
on its own review is not starved) while still blocking when a DIFFERENT card's
PR is open. The "own PR" match keys off the card's branch — preferring the
structured `branch_name` column so the match survives a stage that wedged
before persisting a `Branch:` description block (M1-05 limbo, 2026-05-26).
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.services.github_client import OpenPR, PRStatus
from app.services.scheduling.preconditions import (
    PreconditionContext,
    _extract_card_branch,
    _extract_card_pr_url,
    _pr_is_open,
    _repo_has_no_open_pr,
)


class _FakeGitHubClient:
    def __init__(
        self,
        open_prs: list[OpenPR] | None = None,
        pr_status: PRStatus | None = None,
        pr_status_error: Exception | None = None,
    ):
        self._open_prs = open_prs or []
        self._pr_status = pr_status
        self._pr_status_error = pr_status_error
        self.get_pr_status_calls: list[str] = []

    async def list_open_prs(self, repo_url: str) -> list[OpenPR]:
        return self._open_prs

    async def get_pr_status(self, pr_url: str) -> PRStatus:
        self.get_pr_status_calls.append(pr_url)
        if self._pr_status_error is not None:
            raise self._pr_status_error
        assert self._pr_status is not None, "pr_status not configured on fake"
        return self._pr_status


def test_extract_card_branch_prefers_branch_name_column():
    card = Card(branch_name="runner/m1-05-foo", description="no branch block here")
    assert _extract_card_branch(card) == "runner/m1-05-foo"


def test_extract_card_branch_falls_back_to_description():
    card = Card(branch_name=None, description="Branch: runner/legacy-bar\nmore")
    assert _extract_card_branch(card) == "runner/legacy-bar"


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_passes_for_cards_own_pr_via_branch_name(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """The card's own open PR (matched via branch_name) must NOT block it —
    otherwise a card that committed + opened a PR but whose stage wedged before
    completing gets stranded (implementer's repo_has_no_open_pr excludes it,
    reviewer can't see it). This is the M1-05 limbo cure."""
    test_card.branch_name = "runner/m1-05-foo"
    await db_session.flush()

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=5, head_branch="runner/m1-05-foo", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is True


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_blocks_when_other_card_pr_open(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """A DIFFERENT card's open PR still blocks (the gate's real job)."""
    test_card.branch_name = "runner/m1-05-foo"
    await db_session.flush()

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=9, head_branch="runner/some-other-card", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is False


# ---------------------------------------------------------------------------
# Cell #2: a PR held by an OUT-OF-PLAY (parked) card must not gate siblings.
#
# repo_has_no_open_pr excuses the asker's OWN branch but had no awareness of
# OTHER cards' states — so a parked card (bad slug / blocked / needs-reconcile /
# awaiting-approval) holding an open PR wedged every healthy sibling board-wide.
# The cure: skip a PR whose branch belongs to any parked card, exactly as the
# asker's own branch is skipped. A LIVE card's PR must still block.
# ---------------------------------------------------------------------------


async def _make_card_on_board(db, board, sibling_of, *, branch, labels):
    """A sibling card on the same board/column/owner as `sibling_of` (the
    fixture card), differing only in branch + labels."""
    from app.models.kanban.card import Card as _Card

    card = _Card(
        board_id=board.id,
        column_id=sibling_of.column_id,
        created_by=sibling_of.created_by,
        title="sibling",
        description="",
        branch_name=branch,
        labels=labels,
    )
    db.add(card)
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_ignores_parked_cards_pr(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """A PR held by a PARKED card (repo-slug-unresolved) must NOT block the
    asking healthy card — the parked card is out of play (cell #2)."""
    test_card.branch_name = "feat/healthy"
    await db_session.flush()
    await _make_card_on_board(
        db_session, test_board, test_card,
        branch="feat/ghost", labels=["repo-slug-unresolved"],
    )

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=77, head_branch="feat/ghost", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is True


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_still_blocks_live_cards_pr(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """Blast-radius guard: a LIVE (unlabeled) card's open PR still blocks. The
    cure narrows the gate to parked cards only — it must not disable it."""
    test_card.branch_name = "feat/healthy"
    await db_session.flush()
    await _make_card_on_board(
        db_session, test_board, test_card,
        branch="feat/live", labels=[],
    )

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=88, head_branch="feat/live", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is False


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_parked_card_without_branch_excuses_nothing(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """A parked card with NO branch cannot excuse a PR — the excuse keys on a
    real branch match, never an empty string."""
    test_card.branch_name = "feat/healthy"
    await db_session.flush()
    await _make_card_on_board(
        db_session, test_board, test_card,
        branch=None, labels=["blocked"],
    )

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=99, head_branch="feat/orphan", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is False


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_parked_branch_via_legacy_description_footer(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """The branch of a parked card with NO branch_name column but a legacy
    `Branch:` description footer is still recognized — the perf-projected query
    must preserve the description-fallback path, not just the structured column.
    """
    from app.models.kanban.card import Card as _Card

    test_card.branch_name = "feat/healthy"
    await db_session.flush()
    legacy = _Card(
        board_id=test_board.id,
        column_id=test_card.column_id,
        created_by=test_card.created_by,
        title="legacy parked",
        description="Some notes.\nBranch: feat/legacy-ghost\nmore",
        branch_name=None,
        labels=["repo-slug-unresolved"],
    )
    db_session.add(legacy)
    await db_session.flush()

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=70, head_branch="feat/legacy-ghost", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is True


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_non_parked_label_still_blocks(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_git_repo,
):
    """A card carrying a NON-parked routing label (needs-ui-validation) is live
    mid-pipeline work — its open PR must STILL block the implementer. This pins
    the deliberate exclusion of needs-ui-validation from PARKED_CARD_LABELS."""
    test_card.branch_name = "feat/healthy"
    await db_session.flush()
    await _make_card_on_board(
        db_session, test_board, test_card,
        branch="feat/awaiting-ui", labels=["needs-ui-validation"],
    )

    ctx = PreconditionContext(
        db=db_session,
        card=test_card,
        board_id=test_board.id,
        role="implementer",
        github_client_factory=lambda: _FakeGitHubClient(
            [OpenPR(number=71, head_branch="feat/awaiting-ui", url="u")]
        ),
    )

    assert await _repo_has_no_open_pr(ctx) is False


def test_parked_labels_match_default_pipeline_excludes():
    """Parity guard: every parked label (minus the role-agnostic
    repo-slug-unresolved hardcode) must appear in the implementer's
    DEFAULT_PIPELINE_CONFIG exclude_label set — so the out-of-play definition
    used by the open-PR gate can't drift from the discover exclusions that put
    the card out of play in the first place.

    `needs-ui-validation` is deliberately NOT a parked label: a card awaiting UI
    validation is live mid-pipeline work whose open PR SHOULD still gate the
    implementer; it's excluded from implementer discover only as a routing
    signal, not because it's out of play.
    """
    from app.services.scheduling.preconditions import PARKED_CARD_LABELS
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    impl = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "implementer"
    )
    impl_excludes = set(impl["discover"]["filters"]["exclude_label"])

    # repo-slug-unresolved is enforced role-agnostically in code, not via the
    # config exclude_label list — so exempt it from the config-parity check.
    config_backed = PARKED_CARD_LABELS - {"repo-slug-unresolved"}
    assert config_backed <= impl_excludes, (
        f"parked labels {config_backed - impl_excludes} are not in the "
        "implementer exclude_label set — the out-of-play definitions drifted"
    )
    assert "needs-ui-validation" not in PARKED_CARD_LABELS


# ---------------------------------------------------------------------------
# Cluster II Gap 1: the pr_is_open precondition.
#
# require_pr_url (a discover filter) only confirms the card description carries
# a /pull/ URL — a CLOSED/MERGED/DELETED PR's url still satisfies it, which let
# the rework_mediator re-spin on a card whose PR was already gone (facet 3,
# client pilot 2026-05-27). pr_is_open verifies the card's OWN PR is actually
# open via the same github_client_factory seam repo_has_no_open_pr uses; both
# get abstracted together when the GitHostProvider interface (card d8f7eba4
# Layer 2) lands. Soft-passes when GITHUB_TOKEN is unset (provider-neutral
# fallback) and when the card has no PR url at all.
# ---------------------------------------------------------------------------


PR_URL = "https://github.com/acme/acme/pull/42"


def test_extract_card_pr_url_prefers_pr_url_column():
    card = Card(pr_url=PR_URL, description="see https://github.com/acme/acme/pull/7")
    assert _extract_card_pr_url(card) == PR_URL


def test_extract_card_pr_url_falls_back_to_description():
    card = Card(pr_url=None, description=f"work here: {PR_URL} thanks")
    assert _extract_card_pr_url(card) == PR_URL


def test_extract_card_pr_url_none_when_absent():
    card = Card(pr_url=None, description="no link at all")
    assert _extract_card_pr_url(card) is None


# Cell #11 (white-label leak): the description-footer fallback recognized ONLY
# `github.com/.../pull/N`. The runner ALSO ships a Gitea forge (self-hosted,
# `<host>/<owner>/<repo>/pulls/N`); GitLab (`/-/merge_requests/N`) is the next
# forward-looking forge. A non-GitHub PR card whose structured `pr_url` column
# is NULL (pre-UX-3 / hand-authored) must still be recognized so the reviewer
# discover filter + pr_is_open don't make it invisible.
GITEA_PR_URL = "https://gitea.example.com/acme/widgets/pulls/7"
GITLAB_MR_URL = "https://gitlab.com/acme/widgets/-/merge_requests/42"


def test_extract_card_pr_url_falls_back_to_gitea_pulls_url():
    card = Card(pr_url=None, description=f"opened {GITEA_PR_URL} for review")
    assert _extract_card_pr_url(card) == GITEA_PR_URL


def test_extract_card_pr_url_falls_back_to_gitlab_merge_request_url():
    card = Card(pr_url=None, description=f"MR up: {GITLAB_MR_URL} please review")
    assert _extract_card_pr_url(card) == GITLAB_MR_URL


def test_extract_card_pr_url_ignores_non_pr_forge_links():
    """Strictness guard: a plain repo / issue / file link is NOT a PR url."""
    card = Card(
        pr_url=None,
        description=(
            "repo https://github.com/acme/acme and "
            "issue https://gitea.example.com/acme/widgets/issues/9 and "
            "file https://gitlab.com/acme/widgets/-/blob/main/x.py"
        ),
    )
    assert _extract_card_pr_url(card) is None


def test_extract_card_pr_url_ignores_github_pulls_plural_typo():
    """The host-agnostic Gitea branch (/pulls/) must NOT swallow a hand-authored
    `github.com/.../pulls/N` typo — GitHub uses /pull/ singular and never emits
    /pulls/, so accepting it would mistake a typo for a real Gitea PR (caught by
    the cell #11 adversarial review; the github.com negative lookahead fixes it)."""
    card = Card(pr_url=None, description="typo: https://github.com/acme/acme/pulls/42")
    assert _extract_card_pr_url(card) is None


@pytest.mark.asyncio
async def test_pr_is_open_passes_when_pr_open(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    test_card.pr_url = PR_URL
    await db_session.flush()
    fake = _FakeGitHubClient(pr_status=PRStatus(merged=False, mergeable=True, state="open"))
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: fake,
    )
    assert await _pr_is_open(ctx) is True
    assert fake.get_pr_status_calls == [PR_URL]


@pytest.mark.asyncio
async def test_pr_is_open_blocks_when_pr_closed(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    test_card.pr_url = PR_URL
    await db_session.flush()
    fake = _FakeGitHubClient(pr_status=PRStatus(merged=False, mergeable=None, state="closed"))
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: fake,
    )
    assert await _pr_is_open(ctx) is False


@pytest.mark.asyncio
async def test_pr_is_open_blocks_when_pr_merged(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    """A merged PR is not 'open' — the card already shipped; the mediator must
    not re-spin on it (the auto-merge-then-trailing-verdict ordering trap)."""
    test_card.pr_url = PR_URL
    await db_session.flush()
    fake = _FakeGitHubClient(pr_status=PRStatus(merged=True, mergeable=None, state="closed"))
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: fake,
    )
    assert await _pr_is_open(ctx) is False


@pytest.mark.asyncio
async def test_pr_is_open_soft_passes_when_no_pr_url(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    """No PR url on the card → soft pass. The require_pr_url FILTER owns the
    'has a url at all' gate; this precondition only judges openness."""
    test_card.pr_url = None
    test_card.description = "no pr here"
    await db_session.flush()
    fake = _FakeGitHubClient(pr_status=PRStatus(merged=False, mergeable=True, state="open"))
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: fake,
    )
    assert await _pr_is_open(ctx) is True
    assert fake.get_pr_status_calls == []


@pytest.mark.asyncio
async def test_pr_is_open_soft_passes_when_no_github_token(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    """No GitHub client (token unset) → soft pass, provider-neutral fallback."""
    test_card.pr_url = PR_URL
    await db_session.flush()
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: None,
    )
    assert await _pr_is_open(ctx) is True


@pytest.mark.asyncio
async def test_pr_is_open_soft_passes_on_github_error(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    """A GitHub API error must not wedge the scheduler — soft pass, like
    repo_has_no_open_pr's list-failure branch."""
    test_card.pr_url = PR_URL
    await db_session.flush()
    fake = _FakeGitHubClient(pr_status_error=RuntimeError("502 from github"))
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="rework_mediator", github_client_factory=lambda: fake,
    )
    assert await _pr_is_open(ctx) is True


@pytest.mark.asyncio
async def test_pr_is_open_soft_passes_for_non_github_pr_url(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    """Cell #11 white-label contract: now that discovery ACCEPTS a Gitea PR
    card, the pr_is_open precondition must not WEDGE it. The legacy GitHubClient
    raises ValueError on a non-github url; the precondition's soft-pass swallows
    it — openness-gating is simply OFF for non-GitHub forges (mirroring the
    missing-token fallback) until a forge-native status client lands. The runner
    owns the actual Gitea review/merge via internal/forge."""
    from app.services.github_client import GitHubClient

    test_card.pr_url = "https://gitea.example.com/acme/widgets/pulls/7"
    await db_session.flush()
    # A real GitHubClient (token set) — its get_pr_status raises ValueError on a
    # non-github url, which the precondition must soft-pass, not propagate.
    real_client = GitHubClient(token="t")
    ctx = PreconditionContext(
        db=db_session, card=test_card, board_id=test_board.id,
        role="reviewer", github_client_factory=lambda: real_client,
    )
    assert await _pr_is_open(ctx) is True
