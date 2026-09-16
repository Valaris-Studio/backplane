# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Merged-PR → Done reconciler (docs/loop-mode-contract.md).

One human action (merging a PR) must not require a second, unrelated human
action (moving the card): dependency satisfaction keys strictly on done-typed
columns, so a forgotten move silently starves loop mode. Two paths land a
card in its board's done column:

- **Event**: `merge_queue.merged` — the platform's own merge executor just
  merged the entry's PR. The event is the proof; no GitHub round-trip.
- **Poll**: `scan_once` — cards sitting in review-typed columns carrying a
  GitHub PR URL are checked against GitHub. Covers merges done directly on
  the forge UI, where no platform event exists.

Gate policy (owner-aligned 2026-08-07): a merged PR is the strongest form of
landing — the human who merged IS the review. The reconciler runs as a
background task with no agent contextvar, so `_enforce_done_merge_gate`
treats its moves as human-driven: neither the PR re-check nor the
reviewer-verdict backstop applies. That backstop exists to stop *agents*
landing unreviewed work; the reconciler only ever acts on an already-merged
PR. This is by design, not an accident of the contextvar.
"""

import logging
import uuid
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.exceptions import BadGatewayError, ConflictError, ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.services.github_client import (
    ForgeAuthError,
    GitHubClient,
    PRStatus,
    is_github_pr_url,
)
from app.services.kanban.pr_extract import extract_pr_url

logger = logging.getLogger(__name__)

# Poll-path bound per pass: keeps a pathological board census from turning one
# tick into hundreds of GitHub calls. Unlanded cards simply wait for the next
# tick — the poll is a reconciler, not a queue.
SCAN_LIMIT = 50


async def board_scoped_pr_status(
    db: AsyncSession, board_id: uuid.UUID, pr_url: str
) -> PRStatus | None:
    """PR status read with the BOARD's repo credential, or None when nothing
    can read it.

    None keeps the poll's own rule intact — never move a card on anything
    short of a positive merged=True — while naming the missing credential, so
    an operator whose cards silently stopped landing can see why.
    """
    from app.repositories.git.git_repo import GitRepoRepository
    from app.services.completion import canonical_repo_url
    from app.services.completion_policy import CompletionPolicyService
    from app.services.git.repo_credentials import credential_for_board, credential_for_repo

    board = await db.get(Board, board_id)
    policy = await CompletionPolicyService(db).effective_policy(board) if board else None
    if policy is not None:
        identity = canonical_repo_url(pr_url.rsplit("/pull/", 1)[0])
        repo = next((r for r in await GitRepoRepository(db).list_by_board(board_id)
                     if canonical_repo_url(r.url) == identity), None)
        if repo is None:
            return None
        credential = await credential_for_repo(db, repo)
    else:
        credential = await credential_for_board(db, board_id)
    if credential.token is None:
        credential.warn("reconciler", board=board_id, pr=pr_url)
        return None

    client = GitHubClient(token=credential.token, base_url=settings.GITHUB_API_URL)
    try:
        status = await client.get_pr_status(pr_url)
        if policy is not None and policy.require_forge_checks:
            checks = await client.get_pr_ci_state(pr_url, expected_head_sha=status.head_sha)
            status = replace(status, checks_passed=checks == "green")
    except ForgeAuthError as exc:
        await credential.record_failure(db, str(exc))
        raise
    await credential.record_success(db)
    return status


class MergedPRReconciler:
    """Both reconcile paths behind one object.

    `pr_status_fetcher` is the injectable GitHub seam (tests pass a fake); the
    default resolves the board's own repo credential, the same one the
    done-merge gate uses. `session_factory` is only needed for the event path,
    which opens its own session per event (webhook_subscriber shape);
    `scan_once` takes the caller's session so the main.py loop owns the
    transaction.
    """

    def __init__(self, session_factory, pr_status_fetcher=None):
        self._session_factory = session_factory
        self._fetch_pr_status = pr_status_fetcher
        self._unsubscribe = None
        self._completion_scan_offset = 0

    def start(self, bus) -> None:
        from app.services.merge_queue import MERGE_QUEUE_MERGED

        self._unsubscribe = bus.subscribe(
            callback=self._handle_event, event_pattern=MERGE_QUEUE_MERGED
        )

    def stop(self) -> None:
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None

    async def _handle_event(self, event) -> None:
        # Origin-only: under the postgres bus every replica sees every event;
        # without this guard N replicas race the same move (webhook_subscriber
        # precedent).
        if event.remote:
            return
        try:
            card_id = uuid.UUID(str(event.payload.get("card_id", "")))
        except ValueError:
            logger.warning(
                "reconciler: merge_queue.merged without a usable card_id: %s",
                event.payload,
            )
            return
        try:
            async with self._session_factory() as session:
                async with session.begin():
                    card = await session.get(Card, card_id)
                    if card is None:
                        return  # deleted card — nothing to land
                    from app.services.completion_policy import CompletionPolicyService
                    service = CompletionPolicyService(session)
                    # The publisher may still own the workspace lock. Read durable
                    # queue state first; pre-commit events must never wait for it.
                    entry = None
                    if event.payload.get("entry_id"):
                        from app.models.agents.merge_queue import MergeQueueEntry
                        try:
                            entry_id = uuid.UUID(str(event.payload["entry_id"]))
                        except ValueError:
                            return
                        entry = await session.get(MergeQueueEntry, entry_id)
                        if (entry is None or entry.state != "merged" or entry.card_id != card.id
                                or entry.workspace_id != event.workspace_id
                                or str(entry.repo_id) != str(event.payload.get("repo_id"))
                                or entry.pr_url != event.payload.get("pr_url")):
                            return
                    board = await service.repo.board(card.board_id)
                    if await service.effective_policy(board) is not None:
                        if entry is None:
                            return
                        board = await service.lock_board_for_completion(card.board_id)
                        card = await service.repo.card(card.id, board.id, lock=True)
                        if entry.workspace_id != board.workspace_id or entry.pr_url != card.pr_url:
                            return
                        status = await self._pr_status(session, card.board_id, entry.pr_url)
                        await self._record_completion(session, board, card, status)
                        return
                    # The platform's own executor merged this PR; the event is
                    # the proof, so no GitHub re-check.
                    await self._land_card(session, card)
        except Exception:
            logger.exception(
                "reconciler: failed to land card %s after merge_queue.merged",
                card_id,
            )

    async def scan_once(self, db: AsyncSession) -> int:
        """One poll pass: land every review-column card whose GitHub PR is
        merged. Returns the number of cards moved. Fail-soft per card — an
        unreachable GitHub or vanished PR skips quietly and retries next pass;
        never move a card on anything short of a positive merged=True."""
        rows = (
            await db.execute(
                select(Card)
                .join(Column, Column.id == Card.column_id)
                .where(Column.column_type == ColumnType.review)
                .order_by(Card.updated_at)
                .limit(SCAN_LIMIT)
            )
        ).scalars().all()

        # Source acceptance must survive a column move or a missed/pre-commit event.
        from app.models.kanban.completion import CompletionCandidate
        completion_rows = (await db.scalars(
            select(Card).join(CompletionCandidate, CompletionCandidate.card_id == Card.id)
            .where(CompletionCandidate.is_current.is_(True), CompletionCandidate.status == "awaiting_merge")
            .order_by(CompletionCandidate.created_at, CompletionCandidate.id)
            .offset(self._completion_scan_offset).limit(SCAN_LIMIT)
        )).all()
        self._completion_scan_offset = self._completion_scan_offset + SCAN_LIMIT if len(completion_rows) == SCAN_LIMIT else 0
        rows = list({card.id: card for card in [*completion_rows, *rows]}.values())

        moved = 0
        for card in rows:
            pr_url = card.pr_url or extract_pr_url(card.description or "")
            if not pr_url or not is_github_pr_url(pr_url):
                continue  # no PR, or a forge we can't query yet — gate parity
            try:
                status = await self._pr_status(db, card.board_id, pr_url)
            except (BadGatewayError, ResourceNotFoundError):
                continue
            if status is None or not status.merged:
                continue
            from app.services.completion_policy import CompletionPolicyService
            policy_service = CompletionPolicyService(db)
            board = await policy_service.lock_board_for_completion(card.board_id)
            if await policy_service.effective_policy(board) is not None:
                try:
                    if await self._record_completion(db, board, card, status):
                        moved += 1
                except (ConflictError, ResourceNotFoundError) as exc:
                    logger.info("reconciler: completion remains held for %s: %s", card.id, exc)
                continue
            if await self._land_card(db, card):
                moved += 1
        return moved

    async def _record_completion(self, db, board, card, status) -> bool:
        if status is None or not status.merged:
            return False
        from app.services.completion import CompletionService
        prior_column = card.column_id
        await CompletionService(db).record_merge(board, card, status)
        return card.column_id != prior_column

    async def _pr_status(
        self, db: AsyncSession, board_id: uuid.UUID, pr_url: str
    ) -> PRStatus | None:
        """An injected fetcher keeps its url-only signature (tests, and any
        caller that already knows which credential to use); the default
        resolves per board."""
        if self._fetch_pr_status is not None:
            return await self._fetch_pr_status(pr_url)
        return await board_scoped_pr_status(db, board_id, pr_url)

    async def _land_card(self, db: AsyncSession, card: Card) -> bool:
        """Move a card to its board's done column. Idempotent: already-done or
        no-done-column boards are no-ops. Returns whether a move happened."""
        # Local import: CardService imports nothing from this module, but keep
        # the top-level graph acyclic with the rest of the kanban services.
        from app.repositories.kanban.card import CardRepository
        from app.schemas.kanban.card import CardMoveRequest
        from app.services.kanban.card import CardService

        # start-prod.sh runs two gunicorn workers, each with its own poll
        # loop, and both reconcile paths share this seam — so the already-done
        # check must not trust the identity map: re-read the row, and on
        # Postgres take the row lock (SKIP LOCKED: a locked row means another
        # worker is landing this card right now, and skipping IS the no-op we
        # want). SQLite drops the hint (pop_next precedent).
        stmt = (
            select(Card)
            .where(Card.id == card.id)
            .execution_options(populate_existing=True)
        )
        dialect = db.bind.dialect.name if db.bind is not None else ""
        if dialect == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)
        card = (await db.execute(stmt)).scalar_one_or_none()
        if card is None:
            return False  # deleted, or another worker holds the row lock

        current = await db.get(Column, card.column_id)
        if current is not None and current.column_type == ColumnType.done:
            return False

        done_column = (
            await db.execute(
                select(Column)
                .where(
                    Column.board_id == card.board_id,
                    Column.column_type == ColumnType.done,
                )
                .order_by(Column.position)
            )
        ).scalars().first()
        if done_column is None:
            return False

        workspace_id = (
            await db.execute(
                select(Board.workspace_id).where(Board.id == card.board_id)
            )
        ).scalar_one_or_none()
        if workspace_id is None:
            return False

        position = (
            await CardRepository(db).get_max_position(done_column.id) + 1024.0
        )
        await CardService(db).move_card(
            card.id,
            card.board_id,
            CardMoveRequest(column_id=done_column.id, position=position),
            workspace_id=workspace_id,
            # Activity.actor_id is NOT NULL and there is no system user; the
            # card's creator is the established stand-in for platform-driven
            # writes (ConsolidatorCardCreator precedent). The summary is what
            # marks the move as the reconciler's.
            actor_id=card.created_by,
            activity_summary=(
                f"reconciler: PR merged — auto-landed '{card.title}' "
                f"in '{done_column.name}'"
            ),
        )
        logger.info(
            "reconciler: landed card %s in done column %s (board %s)",
            card.id,
            done_column.id,
            card.board_id,
        )
        return True
