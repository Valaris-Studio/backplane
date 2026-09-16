# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Role-scoped scheduling preconditions.

A precondition is a named gate declared on a discover stage in the
pipeline config. The scheduler refuses to hand a card to the runner
unless every precondition the stage declares evaluates to true.

The first entry — `repo_has_no_open_pr` — relocates the runner-side
Phase-1B stale-baseline guard (runner card 9bb8ba47) into a server-
side, role-scoped check. Stages that fork a NEW branch from `main`
(orchestrator's discover) opt in. Stages that operate on an existing
branch (reviewer/documentator) do not, so a reviewer is never starved
by the orchestrator's own open PR.

Adding a precondition: append a name to `KNOWN_PRECONDITIONS`,
register an evaluator in `EVALUATORS`. The pipeline-config validator
rejects unknown names with a 422.
"""

from __future__ import annotations

import inspect
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.git.git_repo import GitRepo
from app.services.github_client import GitHubClient
from app.services.notes.content_serializer import project_pm_to_text

if TYPE_CHECKING:
    from app.models.kanban.card import Card

logger = logging.getLogger(__name__)


@dataclass
class PreconditionContext:
    """Runtime data a precondition evaluator may inspect."""

    db: AsyncSession
    card: "Card"
    board_id: object  # uuid.UUID; avoid import cycle
    role: str
    # Board-scoped and async in production (credential resolution reads the
    # DB); older call sites and tests pass a sync one. `_client_from` accepts
    # either.
    github_client_factory: Callable[
        [], GitHubClient | None | Awaitable[GitHubClient | None]
    ]


PreconditionEvaluator = Callable[[PreconditionContext], Awaitable[bool]]


# Labels that take a card OUT OF PLAY — the scheduler has parked it and no role
# will hand it out until an operator (or board_reconciler) clears the signal. A
# PR held by such a card is NOT live competing work, so it must not gate the
# `repo_has_no_open_pr` check board-wide (cell #2: the parked-PR wedge). These
# mirror the discovery-excluding labels in DEFAULT_PIPELINE_CONFIG's implementer
# `exclude_label` plus the role-agnostic `repo-slug-unresolved` hardcode. Kept
# here (not imported) to avoid a scheduling→service import cycle; the parity is
# asserted by test_parked_labels_match_default_pipeline_excludes.
PARKED_CARD_LABELS = frozenset(
    {"repo-slug-unresolved", "blocked", "needs-reconcile", "awaiting-approval"}
)


def board_github_client_factory(db: AsyncSession, board_id: object):
    """A client built from the BOARD's repo credential, or None.

    The old factory closed over `settings.GITHUB_TOKEN`, so a workspace whose
    forge the platform has no account on flew with the gate permanently off and
    the one warning it got named no board. Async because resolution reads
    git_repos + git_connections; the evaluators await it.

    None means "no credential" and keeps the historical soft-pass — a
    hard-fail here deadlocks every workspace that configures nothing.
    """
    from app.services.git.repo_credentials import credential_for_board

    async def _make() -> GitHubClient | None:
        credential = await credential_for_board(db, board_id)
        if credential.token is None:
            credential.warn("scheduling precondition", board=board_id)
            return None
        return GitHubClient(
            token=credential.token, base_url=settings.GITHUB_API_URL
        )

    return _make


async def _client_from(ctx: PreconditionContext) -> GitHubClient | None:
    """Call the context's factory, tolerating both the async board-scoped
    factory and the sync one older call sites (and tests) still pass."""
    client = ctx.github_client_factory()
    if inspect.isawaitable(client):
        client = await client
    return client


async def _repo_has_no_open_pr(ctx: PreconditionContext) -> bool:
    """True iff the card's repos have no other open PR.

    "Other" = any open PR whose head branch is not the card's own
    branch. The card-in-review case (where the only open PR is the
    one being reviewed) is allowed; this is what fixes the reviewer
    starvation reported in card 9bb8ba47.

    A missing credential is treated as a soft pass — the runner's own
    retry loop will catch the case where the merge is genuinely
    blocked. Hard-failing here would deadlock workspaces that have no
    forge credential at all. The factory logs which board lacked one
    and why, so flying without the safety gate is visible per board
    rather than as one process-wide line.
    """
    client = await _client_from(ctx)
    if client is None:
        return True

    result = await ctx.db.execute(
        select(GitRepo).where(GitRepo.board_id == ctx.board_id)
    )
    repos = list(result.scalars().all())
    if not repos:
        return True

    card_branch = _extract_card_branch(ctx.card)
    # Branches owned by OUT-OF-PLAY cards on this board. A PR on one of these is
    # held by a card the scheduler has already parked (bad slug, blocked,
    # needs-reconcile, awaiting-approval) — it is not live competing work, so it
    # must not wedge the gate for healthy siblings board-wide (cell #2). The
    # asker's own branch is already excused below; this extends the same
    # "not-competing" logic to every parked card, not just the asker.
    parked_branches = await _parked_card_branches(ctx.db, ctx.board_id)
    for repo in repos:
        try:
            open_prs = await client.list_open_prs(repo.url)
        except Exception as exc:
            logger.warning(
                "repo_has_no_open_pr: list failed for %s, soft pass: %s",
                repo.url, exc,
            )
            continue
        for pr in open_prs:
            if card_branch and pr.head_branch == card_branch:
                continue
            if pr.head_branch and pr.head_branch in parked_branches:
                continue
            return False
    return True


async def _parked_card_branches(db: AsyncSession, board_id: object) -> set[str]:
    """Branch names of cards on the board that are OUT OF PLAY (carry a parked
    label). Empty branch names are dropped so a card without a branch can't
    accidentally excuse a PR.

    Filters to parked cards SERVER-SIDE (a card carrying ANY parked label) and
    projects only the three columns branch extraction needs — never hydrating
    full Card ORM rows nor the whole board. The label match keys on the quoted
    token (`"blocked"` never matches `"blocked-x"`), mirroring the discover
    exclude_label predicate in _candidate_cards.
    """
    from sqlalchemy import String as SAString
    from sqlalchemy import or_

    from app.models.kanban.card import Card

    label_col = Card.labels.cast(SAString)
    parked_filter = or_(*(label_col.like(f'%"{lbl}"%') for lbl in PARKED_CARD_LABELS))
    result = await db.execute(
        select(Card.branch_name, Card.description).where(
            Card.board_id == board_id, parked_filter
        )
    )
    branches: set[str] = set()
    for branch_name, description in result.all():
        branch = branch_name or _branch_from_description(description or "")
        if branch:
            branches.add(branch)
    return branches


# A PR/MR url anywhere in a text blob — provider-agnostic (cell #11, white-label
# leak). The runner ships GitHub + Gitea forges today (internal/forge/registry:
# "supported: github, gitea") and GitLab is the next forward-looking forge, so
# the description-footer fallback must recognize all three shapes — a card whose
# structured `pr_url` column is NULL (pre-UX-3 / hand-authored) is otherwise
# invisible to the require_pr_url discover filter + pr_is_open precondition on a
# non-GitHub board. Each alternative is anchored to the exact forge path so a
# plain repo / issue / file link never false-matches:
#   - GitHub (host-pinned):   github.com/<owner>/<repo>/pull/<n>
#   - Gitea/Forgejo (self-hosted, host-agnostic): <host>/<owner>/<repo>/pulls/<n>
#   - GitLab (host-agnostic):  <host>/<group>/<repo>/-/merge_requests/<n>
# The structured `pr_url` column always wins first (see _extract_card_pr_url and
# _card_has_pr_url); this regex is the legacy/hand-authored fallback only.
# The Gitea branch is host-agnostic (self-hosted), so it must NOT swallow a
# github.com/<owner>/<repo>/pulls/N typo (GitHub uses /pull/ singular and never
# /pulls/) — the negative lookahead keeps that hand-authored mistake from being
# mistaken for a real Gitea PR, honoring the "only forge-real formats" intent.
_PR_URL_IN_TEXT = re.compile(
    r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+"
    r"|https://(?!github\.com/)[^/\s]+/[^/\s]+/[^/\s]+/pulls/\d+"
    r"|https://[^/\s]+/[^\s]+?/-/merge_requests/\d+"
)


def _text_has_pr_url(text: str) -> bool:
    """The provider-agnostic counterpart of the require_pr_url discover filter's
    description scan — shared with assignment_service._card_has_pr_url so the two
    layers can never diverge on which forge URLs they recognize (the split-brain
    cell #11 closes)."""
    return bool(_PR_URL_IN_TEXT.search(project_pm_to_text(text)))


async def _pr_is_open(ctx: PreconditionContext) -> bool:
    """True unless the card's OWN PR is known to be closed/merged.

    Cluster II Gap 1: the `require_pr_url` discover filter only confirms the
    card carries a PR url — a closed/merged/deleted PR still satisfies it,
    which let the rework_mediator re-spin on a card whose PR was already gone.
    This precondition verifies the PR is actually OPEN.

    Soft-passes (returns True) when:
      - the card has no PR url at all (the `require_pr_url` FILTER owns the
        "must have a url" gate; this precondition only judges openness),
      - no credential can read the board's repo (provider-neutral fallback;
        the factory logs the board and the reason),
      - the GitHub lookup errors (a transient API failure must not wedge the
        scheduler — mirrors `_repo_has_no_open_pr`'s soft-pass discipline).

    Routed through the same `github_client_factory` seam as
    `_repo_has_no_open_pr` so the future GitHostProvider abstraction
    (card d8f7eba4 Layer 2) can swap both consumers in one move.
    """
    pr_url = _extract_card_pr_url(ctx.card)
    if not pr_url:
        return True

    client = await _client_from(ctx)
    if client is None:
        return True

    try:
        status = await client.get_pr_status(pr_url)
    except Exception as exc:
        logger.warning(
            "pr_is_open: status lookup failed for %s, soft pass: %s",
            pr_url, exc,
        )
        return True

    return status.state == "open" and not status.merged


def _extract_card_pr_url(card: "Card") -> str | None:
    """The card's PR url, preferring the structured `pr_url` column over a
    `github.com/.../pull/N` link found in the description (legacy convention)."""
    pr_url = getattr(card, "pr_url", None)
    if pr_url:
        return pr_url
    match = _PR_URL_IN_TEXT.search(project_pm_to_text(card.description or ""))
    return match.group(0) if match else None


def _extract_card_branch(card: "Card") -> str | None:
    """The card's feature branch, preferring the structured `branch_name`
    column over the legacy `Branch:` description block.

    The runner persists `branch_name` at branch-setup time (runner git_setup),
    so it survives a stage that wedges before its PR/ship steps complete —
    which is what lets this precondition recognize the card's own open PR as
    its own on retry instead of stranding it in limbo (M1-05, 2026-05-26). The
    description scan stays as a fallback for cards predating that change /
    hand-authored flows; it returns the LAST `Branch:` block (most recent
    re-claim wins).
    """
    branch_name = getattr(card, "branch_name", None)
    if branch_name:
        return branch_name
    return _branch_from_description(card.description or "")


def _branch_from_description(description: str) -> str | None:
    """The LAST `Branch:` block in a description (most recent re-claim wins).

    Factored out so a column-projected query (which has no Card object) can run
    the same legacy fallback as _extract_card_branch.

    Descriptions are PM JSON post-P0-3 — one giant line the scan would die on
    silently — so project back to text first (no-op on legacy raw strings).
    """
    last_branch: str | None = None
    for line in project_pm_to_text(description).splitlines():
        stripped = line.strip()
        if stripped.startswith("Branch:"):
            value = stripped[len("Branch:"):].strip()
            if value:
                last_branch = value
    return last_branch


EVALUATORS: dict[str, PreconditionEvaluator] = {
    "repo_has_no_open_pr": _repo_has_no_open_pr,
    "pr_is_open": _pr_is_open,
}

KNOWN_PRECONDITIONS = frozenset(EVALUATORS.keys())


async def evaluate_preconditions(
    names: list[str], ctx: PreconditionContext
) -> bool:
    """Return True iff every named precondition passes for ctx."""
    for name in names:
        evaluator = EVALUATORS.get(name)
        if evaluator is None:
            logger.warning(
                "skipping unknown precondition %r — should have been "
                "rejected by pipeline-config validation",
                name,
            )
            continue
        if not await evaluator(ctx):
            return False
    return True
