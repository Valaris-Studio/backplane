# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Backfilling the private session search index for retained history.

Sources stored before search existed have no index row, and an uploaded body
whose post-finalize indexing failed stays pending. A run reaches every
retained source of the scope once per verification epoch, in passes an
operator invokes one at a time (`scripts/backfill_session_search.py`). Each
pass does a bounded amount of work under the run's lease, then exits:

- at most 200 candidate keys examined, counted before membership or index
  filtering;
- at most `source_limit` sources attempted, and never more than 25 claims held
  by the run, exhausted ones included;
- at most `byte_budget` bytes charged: an object's size plus its integrity
  sentinel (failed reads included), an inline body's or event's persisted
  bytes; and one prepared object alive at a time.

A run first re-reads the objects already recorded unavailable, once, up to
the id it captured when created. It then discovers, and repeats bounded
reconciliation sweeps while authorized work it could process remains
unclaimed: sources committed behind a scan's cursor and late finalization.
Bodies are read outside any transaction. Every index write commits together
with its claim acknowledgement and progress, fenced by the lease on the
database clock, taking locks in the order session, content, claim, run.

Only a run that finished with nothing pending, nothing claimed and its
verification complete reports `ready_at_observation`, and only for the moment
it observed; the session search's own `index_ready` keeps its meaning."""

import hashlib
import json
import logging
import os
import uuid
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.core.time import as_utc
from app.models.session_search_backfill import (
    BACKFILL_LANE,
    BACKFILL_SCOPES,
    FINISH_REASONS,
    SessionSearchBackfillClaim,
    SessionSearchBackfillRun,
)
from app.repositories.session_search import ObjectDescriptor, SessionSearchRepository
from app.repositories.session_search_backfill import (
    SETTLED_INDEX_STATUSES,
    ContentCandidate,
    EventCandidate,
    SessionSearchBackfillRepository,
)
from app.schemas.session_content import MAX_TEXT_BODY_BYTES, TEXT_MEDIA_TYPES, WITH_BODY
from app.schemas.session_search_backfill import (
    BackfillClaims,
    BackfillCoverage,
    BackfillOutcomes,
    BackfillPass,
    BackfillProgress,
    BackfillReceipt,
    BackfillRun,
    BackfillVerification,
    PassReceipt,
    Readiness,
    Reason,
    Result,
    StartReceipt,
    StatusReceipt,
)

# The session search's own bucket rules, so scope coverage cannot drift from
# what a session's search reports.
from app.services.session_search import _classify, _Coverage, _Tally
from app.services.session_search_index import (
    ObjectReadAccounting,
    PreparedSource,
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.session_search_text import EXTRACTOR_VERSION
from app.services.storage.session_content import GCSContentStore, content_store

logger = logging.getLogger(__name__)

LEASE_DURATION = timedelta(minutes=10)
MAX_PASS_SOURCES = 25
MAX_RUN_CLAIMS = 25
MAX_PASS_CANDIDATE_KEYS = 200
DEFAULT_BYTE_BUDGET = 64 << 20
MAX_STORAGE_ATTEMPTS = 5
MAX_RETRY_DELAY = timedelta(hours=24)
STORE_FINGERPRINT_VERSION = 1

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_MISMATCH = 3
EXIT_PROGRESS = 10
EXIT_BUSY = 11
EXIT_BACKOFF = 12
EXIT_UNREADY = 13

OUTCOMES = tuple(BackfillOutcomes.model_fields)
VERIFICATION_COUNTERS = (
    "verify_attempted",
    "verify_hash_verified",
    "verify_hash_verified_bytes",
    "verify_missing",
    "verify_mismatch",
    "verify_error",
)
# Preparation outcomes the landed writer settles under its own locks.
WRITER_SETTLED = frozenset(
    {
        "ready",
        "absent",
        "missing_object",
        "wrong_size",
        "digest_mismatch",
        "invalid_utf8",
    }
)

Verdict = Literal["eligible", "skip", "owner_not_member", "invalid_metadata"]
# How a claim settles: an outcome that acknowledges it, a storage failure
# that schedules a retry, or one of the two that keep it for a later pass
# (`changed`: re-read the source; `budget_deferred`).
Settlement = Literal[
    "indexed",
    "unchanged",
    "unavailable",
    "not_text",
    "absent",
    "stale",
    "owner_not_member",
    "invalid_metadata",
    "storage_unavailable",
    "changed",
    "budget_deferred",
]


@dataclass(frozen=True)
class RunIdentity:
    scope: str
    extractor_version: str
    store_fingerprint: str
    store_backend: str

    def matches(self, run: SessionSearchBackfillRun) -> bool:
        return (run.scope, run.extractor_version, run.store_fingerprint) == (
            self.scope,
            self.extractor_version,
            self.store_fingerprint,
        )


def effective_identity(scope: str) -> RunIdentity:
    """The run identity of the configuration this process actually uses. The
    store is hashed where it resolves (the local root after symlinks; the
    bucket plus the emulator the GCS client honors from the environment), so
    an unchanged setting that now points elsewhere still differs."""
    store = content_store()
    if isinstance(store, GCSContentStore):
        location = {
            "backend": store.backend,
            "bucket": store.bucket_name,
            "emulator": os.environ.get("STORAGE_EMULATOR_HOST") or None,
        }
    else:
        location = {"backend": store.backend, "root": str(Path(store.base).resolve())}
    encoded = json.dumps(
        {"v": STORE_FINGERPRINT_VERSION, **location},
        sort_keys=True,
        separators=(",", ":"),
    )
    return RunIdentity(
        scope=scope,
        extractor_version=EXTRACTOR_VERSION,
        store_fingerprint=hashlib.sha256(encoded.encode()).hexdigest(),
        store_backend=store.backend,
    )


class _LeaseLost(Exception):
    """The run is no longer this pass's to change: stop without writing."""


class _OverBudget(Exception):
    """The next source does not fit what remains of the pass's byte budget."""


@dataclass(frozen=True)
class _ClaimView:
    kind: str
    source_id: uuid.UUID
    state: str
    next_attempt_at: datetime | None

    @classmethod
    def of(cls, claim: SessionSearchBackfillClaim) -> "_ClaimView":
        return cls(
            claim.source_kind, claim.source_id, claim.state, claim.next_attempt_at
        )

    @property
    def key(self) -> tuple[str, uuid.UUID]:
        return self.kind, self.source_id

    def due(self, now: datetime) -> bool:
        if self.state == "pending":
            return True
        return (
            self.state == "retry_wait"
            and self.next_attempt_at is not None
            and as_utc(self.next_attempt_at) <= now
        )


# --- which sources a run works on ---


def _is_retained_text(source: ContentCandidate | ObjectDescriptor) -> bool:
    return (
        source.state == "available"
        and source.coverage in WITH_BODY
        and source.media_type in TEXT_MEDIA_TYPES
    )


def _object_metadata_valid(candidate: ContentCandidate, backend: str) -> bool:
    return (
        candidate.byte_count is not None
        and candidate.byte_count <= MAX_TEXT_BODY_BYTES
        and candidate.storage_backend == backend
        and candidate.has_storage_key
    )


def _content_verdict(
    candidate: ContentCandidate, identity: RunIdentity, *, verifying: bool
) -> Verdict:
    """Must agree with SessionSearchBackfillRepository.has_unclaimed_content:
    a row that query calls processable has to be eligible here, or a
    reconciliation sweep would start again forever without claiming it."""
    if not candidate.member:
        return "owner_not_member"
    if not _is_retained_text(candidate):
        return "skip"
    if candidate.sha256 is None:
        return "invalid_metadata"
    recorded = (
        candidate.index_version == identity.extractor_version
        and candidate.index_digest == candidate.sha256
    )
    if verifying:
        if candidate.inline or not (
            recorded and candidate.index_status == "unavailable"
        ):
            return "skip"
    elif recorded and candidate.index_status in SETTLED_INDEX_STATUSES:
        return "skip"
    elif candidate.inline:
        # A legacy or wrong declared size never stands in for the body's.
        return (
            "eligible"
            if candidate.byte_count == candidate.inline_bytes
            else "invalid_metadata"
        )
    if not _object_metadata_valid(candidate, identity.store_backend):
        return "invalid_metadata"
    return "eligible"


def _event_verdict(candidate: EventCandidate, identity: RunIdentity) -> Verdict:
    if not candidate.member:
        return "owner_not_member"
    if (
        candidate.index_version == identity.extractor_version
        and candidate.index_status == "indexed"
    ):
        return "skip"
    return "eligible"


def _processing_route(facts: ContentCandidate, identity: RunIdentity) -> str:
    """How a claimed content source is processed now: `inline` or `object`,
    or settled as `stale` (no longer retained text) or `invalid_metadata`."""
    if not _is_retained_text(facts):
        return "stale"
    if facts.sha256 is None:
        return "invalid_metadata"
    if facts.inline:
        return (
            "inline" if facts.byte_count == facts.inline_bytes else "invalid_metadata"
        )
    if not _object_metadata_valid(facts, identity.store_backend):
        return "invalid_metadata"
    return "object"


def _fingerprint(facts: list) -> str:
    return hashlib.sha256(json.dumps(facts, separators=(",", ":")).encode()).hexdigest()


def _descriptor_fingerprint(read: ObjectDescriptor) -> str:
    return _fingerprint(
        [
            "content",
            str(read.content_id),
            read.sha256,
            read.byte_count,
            read.media_type,
            read.storage_backend,
            read.storage_key is not None,
            read.inline_text is not None,
        ]
    )


def _claim_row(run_id: uuid.UUID, kind: str, candidate) -> dict:
    if kind == "event":
        # An event is sized when it is processed: discovery reads no JSON.
        digest, reserved = None, 0
        fingerprint = _fingerprint([kind, str(candidate.id)])
    else:
        digest = candidate.sha256
        reserved = (
            candidate.inline_bytes if candidate.inline else candidate.byte_count + 1
        )
        fingerprint = _fingerprint(
            [
                kind,
                str(candidate.id),
                candidate.sha256,
                candidate.byte_count,
                candidate.media_type,
                candidate.storage_backend,
                candidate.has_storage_key,
                candidate.inline,
            ]
        )
    return {
        "run_id": run_id,
        "source_kind": kind,
        "source_id": candidate.id,
        "expected_digest": digest,
        "descriptor_fingerprint": fingerprint,
        "reserved_bytes": reserved,
        "attempts": 0,
        "next_attempt_at": None,
        "state": "pending",
        "reason": None,
    }


# --- counters and receipts ---


def _zero_counters() -> dict[str, int]:
    return dict.fromkeys(OUTCOMES + VERIFICATION_COUNTERS, 0)


def _count(run: SessionSearchBackfillRun, **increments: int) -> None:
    counters = {**_zero_counters(), **(run.counters or {})}
    for name, amount in increments.items():
        counters[name] += amount
    run.counters = counters


def _verification_increments(
    prepared_outcome: str, read: ObjectDescriptor | None
) -> dict[str, int]:
    """What settling one verification claim observed of its object."""
    if prepared_outcome in ("ready", "invalid_utf8"):
        return {
            "verify_attempted": 1,
            "verify_hash_verified": 1,
            "verify_hash_verified_bytes": read.byte_count or 0,
        }
    if prepared_outcome == "missing_object":
        return {"verify_attempted": 1, "verify_missing": 1}
    if prepared_outcome in ("wrong_size", "digest_mismatch"):
        return {"verify_attempted": 1, "verify_mismatch": 1}
    if prepared_outcome == "storage_unavailable":
        return {"verify_attempted": 1, "verify_error": 1}
    return {}


def _retry_delay(attempts: int) -> timedelta:
    return min(timedelta(minutes=2**attempts), MAX_RETRY_DELAY)


def _lease_live(run: SessionSearchBackfillRun, now: datetime) -> bool:
    return run.lease_expires_at is not None and as_utc(run.lease_expires_at) > now


@dataclass(frozen=True)
class _ScopeObservation:
    coverage: BackfillCoverage
    # Retained text whose required metadata is missing or cannot be trusted
    # (no digest, unknown or oversized size, an inline size that is not the
    # body's, an object outside the effective store). It keeps a run unready
    # whatever the index recorded for it: B01's writer may have recorded such
    # a body unavailable, which takes it out of pending_index.
    unresolved_metadata: int

    @property
    def settled(self) -> bool:
        return self.coverage.index_ready and self.unresolved_metadata == 0


def _readiness(
    run: SessionSearchBackfillRun,
    scope: _ScopeObservation | None,
    claims: list[_ClaimView],
) -> Readiness | None:
    if scope is None:
        return None
    if run.finished_at is None:
        return "in_progress"
    if run.finish_reason == "clean_observation" and scope.settled and not claims:
        return "ready_at_observation"
    return "exhausted_unready"


async def _scope_coverage(
    repo: SessionSearchBackfillRepository, identity: RunIdentity
) -> _ScopeObservation:
    observed_from = await repo.clock()
    aggregate = await repo.scope_aggregate(
        extractor_version=identity.extractor_version,
        backend=identity.store_backend,
        max_body_bytes=MAX_TEXT_BODY_BYTES,
    )
    observed_at = await repo.clock()
    coverage = _Coverage()
    for row in aggregate.contents:
        _classify(coverage, row)
    coverage.add(
        "indexed",
        aggregate.events_indexed,
        aggregate.events_indexed_bytes,
        aggregate.events_indexed,
    )
    # An event's text size is unknown until it is extracted.
    coverage.add(
        "pending_index", aggregate.events_stored - aggregate.events_indexed, 0, 0
    )
    indexed = coverage.buckets["indexed"]
    pending = coverage.buckets["pending_index"]
    eligible = _Tally(
        indexed.count + pending.count,
        indexed.total + pending.total,
        indexed.unknown or pending.unknown,
    )
    return _ScopeObservation(
        coverage=BackfillCoverage(
            **{name: tally.read() for name, tally in coverage.buckets.items()},
            eligible=eligible.read(),
            eligible_count=eligible.count,
            child_metadata_count=aggregate.child_sessions,
            owner_not_member_count=aggregate.owner_not_member,
            index_ready=pending.count == 0,
            extractor_version=identity.extractor_version,
            observed_from=observed_from,
            observed_at=observed_at,
        ),
        unresolved_metadata=aggregate.unresolved_metadata,
    )


def _refusal(
    receipt_type: type[BackfillReceipt], reason: Reason, exit_code: int, **extra
):
    return receipt_type(
        result="refused",
        reason=reason,
        exit_code=exit_code,
        observed_at=datetime.now(timezone.utc),
        **extra,
    )


@dataclass(frozen=True)
class _Observation:
    """A run as read now, with fresh scope coverage when it is current."""

    run: BackfillRun
    progress: BackfillProgress
    verification: BackfillVerification
    coverage: BackfillCoverage | None
    readiness: Readiness | None
    observed_at: datetime
    scope: str
    configured: bool
    superseded: bool
    finished: bool
    finish_reason: str | None
    unresolved_metadata: bool

    def receipt(
        self,
        receipt_type: type[BackfillReceipt],
        *,
        result: Result,
        reason: Reason,
        exit_code: int,
        **extra,
    ):
        return receipt_type(
            result=result,
            reason=reason,
            exit_code=exit_code,
            observed_at=self.observed_at,
            run=self.run,
            progress=self.progress,
            coverage=self.coverage,
            verification=self.verification,
            readiness=self.readiness,
            **extra,
        )

    def verdict(self) -> tuple[Result, Reason, int]:
        """What the run's current state means when nothing was done to it."""
        if self.superseded:
            return "observed", "run_superseded", EXIT_UNREADY
        if not self.configured:
            return "refused", "configuration_mismatch", EXIT_MISMATCH
        if self.readiness == "ready_at_observation":
            return "observed", "clean_observation", EXIT_OK
        if self.readiness == "exhausted_unready":
            if self.finish_reason != "clean_observation":
                return "observed", self.finish_reason, EXIT_UNREADY
            if self.unresolved_metadata:
                return "observed", "unresolved_metadata", EXIT_UNREADY
            return "observed", "pending_since_finish", EXIT_UNREADY
        return "observed", "in_progress", EXIT_PROGRESS


def _observation(
    run: SessionSearchBackfillRun,
    claims: list[_ClaimView],
    predecessor_id: uuid.UUID | None,
    observed_at: datetime,
    scope: _ScopeObservation | None,
    *,
    created: bool,
    configured: bool,
) -> _Observation:
    counters = {**_zero_counters(), **(run.counters or {})}
    retries = [
        as_utc(claim.next_attempt_at)
        for claim in claims
        if claim.state == "retry_wait" and claim.next_attempt_at is not None
    ]
    superseded = run.phase == "superseded"
    current = scope if configured and not superseded else None
    return _Observation(
        run=BackfillRun(
            id=run.id,
            scope=run.scope,
            extractor_version=run.extractor_version,
            store_fingerprint=run.store_fingerprint,
            phase=run.phase,
            sweep=run.sweep,
            created=created,
            predecessor_id=predecessor_id,
            successor_id=run.superseded_by,
            lease_epoch=run.lease_epoch,
            lease_expires_at=run.lease_expires_at,
            created_at=run.created_at,
            finished_at=run.finished_at,
            finish_reason=run.finish_reason,
        ),
        progress=BackfillProgress(
            outcomes=BackfillOutcomes(**{name: counters[name] for name in OUTCOMES}),
            claims=BackfillClaims(
                outstanding=len(claims),
                due=sum(claim.due(observed_at) for claim in claims),
                exhausted=sum(claim.state == "exhausted" for claim in claims),
                next_attempt_at=min(retries, default=None),
            ),
            discovery_complete=run.phase != "verify_unavailable"
            and run.content_exhausted
            and run.event_exhausted,
            verification_complete=run.verification_finished_at is not None,
        ),
        verification=BackfillVerification(
            epoch_id=run.id,
            started_at=run.verification_started_at,
            finished_at=run.verification_finished_at,
            attempted_objects=counters["verify_attempted"],
            hash_verified_objects=counters["verify_hash_verified"],
            hash_verified_bytes=counters["verify_hash_verified_bytes"],
            missing_objects=counters["verify_missing"],
            mismatch_objects=counters["verify_mismatch"],
            storage_errors=counters["verify_error"],
        ),
        coverage=current.coverage if current is not None else None,
        readiness=_readiness(run, current, claims),
        observed_at=observed_at,
        scope=run.scope,
        configured=configured,
        superseded=superseded,
        finished=run.finished_at is not None,
        finish_reason=run.finish_reason,
        unresolved_metadata=current is not None and current.unresolved_metadata > 0,
    )


@dataclass(frozen=True)
class _StartDecision:
    run_id: uuid.UUID | None
    result: Result
    reason: Reason
    exit_code: int
    created: bool = False


class SessionSearchBackfillService:
    def __init__(self, session_factory: async_sessionmaker):
        self.session_factory = session_factory

    async def schema_ready(self) -> bool:
        async with self.session_factory() as db:
            return await SessionSearchBackfillRepository(db).tables_present()

    # --- start ---

    async def start_run(
        self,
        *,
        scope: str = "all_workspaces",
        new_verification_epoch: bool = False,
        supersede_run_id: uuid.UUID | None = None,
    ) -> StartReceipt:
        if scope not in BACKFILL_SCOPES:
            return _refusal(StartReceipt, "invalid_scope", EXIT_USAGE)
        if not settings.COMPANION_ENABLED:
            return _refusal(StartReceipt, "feature_disabled", EXIT_MISMATCH)
        identity = effective_identity(scope)
        for attempt in range(2):
            try:
                decision = await self._decide_start(
                    identity, new_verification_epoch, supersede_run_id
                )
                break
            except IntegrityError:
                # A concurrent start created the lane's unfinished run first;
                # decide again against that run.
                if attempt:
                    raise
        if decision.run_id is None:
            return _refusal(StartReceipt, decision.reason, decision.exit_code)
        if decision.result == "refused":
            refused = await self._observe(decision.run_id, with_coverage=False)
            return refused.receipt(
                StartReceipt,
                result="refused",
                reason=decision.reason,
                exit_code=decision.exit_code,
            )
        await self._discard_predecessor_claims(decision.run_id)
        observation = await self._observe(
            decision.run_id, with_coverage=True, created=decision.created
        )
        return observation.receipt(
            StartReceipt,
            result=decision.result,
            reason=decision.reason,
            exit_code=EXIT_OK,
        )

    async def _decide_start(
        self,
        identity: RunIdentity,
        new_verification_epoch: bool,
        supersede_run_id: uuid.UUID | None,
    ) -> _StartDecision:
        async with self.session_factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            head = await repo.lock_lane_head(BACKFILL_LANE)
            now = await repo.clock()
            if head is None:
                return await self._create_run(repo, identity, now, None)
            existing = _StartDecision(head.id, "existing", "existing", EXIT_OK)
            if supersede_run_id is not None and supersede_run_id != head.id:
                replaced = await repo.run(supersede_run_id)
                # A repeated supersession: the run it created is the head now.
                if (
                    replaced is not None
                    and replaced.superseded_by == head.id
                    and identity.matches(head)
                ):
                    return existing
                return _StartDecision(
                    head.id, "refused", "supersede_mismatch", EXIT_USAGE
                )
            if head.finished_at is None:
                if supersede_run_id is None:
                    if identity.matches(head):
                        return existing
                    return _StartDecision(
                        head.id, "refused", "configuration_mismatch", EXIT_MISMATCH
                    )
                if _lease_live(head, now):
                    return _StartDecision(head.id, "refused", "lease_live", EXIT_BUSY)
                return await self._create_run(repo, identity, now, head)
            if new_verification_epoch or supersede_run_id == head.id:
                return await self._create_run(repo, identity, now, head)
            if identity.matches(head):
                return existing
            return _StartDecision(
                head.id, "refused", "configuration_mismatch", EXIT_MISMATCH
            )

    async def _create_run(
        self,
        repo: SessionSearchBackfillRepository,
        identity: RunIdentity,
        now: datetime,
        predecessor: SessionSearchBackfillRun | None,
    ) -> _StartDecision:
        run_id = uuid.uuid4()
        if predecessor is not None:
            if predecessor.finished_at is None:
                # Fenced before its successor exists: a late settlement under
                # the old lease now fails both its epoch and unfinished checks.
                predecessor.phase = "superseded"
                predecessor.finished_at = now
                predecessor.finish_reason = "superseded"
                predecessor.lease_epoch += 1
                predecessor.lease_expires_at = None
            predecessor.superseded_by = run_id
            # Flushed first, so the lane's one-unfinished-run index never
            # sees both.
            await repo.db.flush()
        content_upper = await repo.last_content_id()
        await repo.add_run(
            id=run_id,
            lane=BACKFILL_LANE,
            scope=identity.scope,
            extractor_version=identity.extractor_version,
            store_fingerprint=identity.store_fingerprint,
            phase="verify_unavailable",
            sweep=0,
            content_upper=content_upper,
            content_exhausted=content_upper is None,
            event_exhausted=False,
            lease_epoch=0,
            created_at=now,
            counters=_zero_counters(),
            verification_started_at=now,
        )
        return _StartDecision(run_id, "created", "created", EXIT_OK, created=True)

    async def _discard_predecessor_claims(self, run_id: uuid.UUID) -> None:
        # Its own transaction, after the fence committed: it may wait on a
        # claim row a late settlement holds, and must hold no run lock then.
        async with self.session_factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            predecessor_id = await repo.predecessor_id(run_id)
            if predecessor_id is not None:
                await repo.delete_claims(predecessor_id)

    # --- status ---

    async def status(self, run_id: uuid.UUID) -> StatusReceipt:
        observation = await self._observe(run_id, with_coverage=True)
        if observation is None:
            return _refusal(StatusReceipt, "unknown_run", EXIT_USAGE)
        result, reason, exit_code = observation.verdict()
        return observation.receipt(
            StatusReceipt, result=result, reason=reason, exit_code=exit_code
        )

    async def _observe(
        self,
        run_id: uuid.UUID,
        *,
        with_coverage: bool,
        scope: _ScopeObservation | None = None,
        created: bool = False,
    ) -> _Observation | None:
        async with self.session_factory() as db:
            repo = SessionSearchBackfillRepository(db)
            run = await repo.run(run_id)
            if run is None:
                return None
            claims = [_ClaimView.of(claim) for claim in await repo.claims(run_id)]
            predecessor_id = await repo.predecessor_id(run_id)
            observed_at = await repo.clock()
            identity = effective_identity(run.scope)
            configured = identity.matches(run)
            if (
                scope is None
                and with_coverage
                and configured
                and run.phase != "superseded"
            ):
                scope = await _scope_coverage(repo, identity)
            return _observation(
                run,
                claims,
                predecessor_id,
                observed_at,
                scope,
                created=created,
                configured=configured,
            )

    # --- one bounded pass ---

    async def run_pass(
        self,
        run_id: uuid.UUID,
        *,
        source_limit: int = MAX_PASS_SOURCES,
        byte_budget: int = DEFAULT_BYTE_BUDGET,
    ) -> PassReceipt:
        measures = BackfillPass(source_limit=source_limit, byte_budget=byte_budget)
        if (
            not 1 <= source_limit <= MAX_PASS_SOURCES
            or not 1 <= byte_budget <= DEFAULT_BYTE_BUDGET
        ):
            return _refusal(
                PassReceipt, "invalid_limits", EXIT_USAGE, pass_metrics=measures
            )
        if not settings.COMPANION_ENABLED:
            return _refusal(
                PassReceipt, "feature_disabled", EXIT_MISMATCH, pass_metrics=measures
            )
        before = await self._observe(run_id, with_coverage=False)
        if before is None:
            return _refusal(
                PassReceipt, "unknown_run", EXIT_USAGE, pass_metrics=measures
            )
        if not before.configured and not before.superseded:
            # Claims stay untouched: a corrected configuration continues
            # through an explicit successor, never through this run.
            return before.receipt(
                PassReceipt,
                result="refused",
                reason="configuration_mismatch",
                exit_code=EXIT_MISMATCH,
                pass_metrics=measures,
            )
        if before.finished:
            return await self._observed_pass(run_id, measures)
        epoch = await self._acquire_lease(run_id)
        if epoch is None:
            busy = await self._observe(run_id, with_coverage=False)
            if busy.finished:
                return await self._observed_pass(run_id, measures)
            return busy.receipt(
                PassReceipt,
                result="busy",
                reason="lease_busy",
                exit_code=EXIT_BUSY,
                pass_metrics=measures,
            )
        worker = _Pass(
            self.session_factory,
            run_id,
            epoch,
            effective_identity(before.scope),
            measures,
        )
        try:
            stop = await worker.run()
        except Exception:
            await worker.release_after_failure()
            raise
        measures.stop_reason = stop
        # A bounded unfinished pass reports its work, not a new whole-corpus
        # scan. Completion still needs current coverage, including a different
        # worker finishing after this worker released its lease.
        after = await self._observe(
            run_id, with_coverage=False, scope=worker.final_scope
        )
        if after is not None and after.finished and worker.final_scope is None:
            after = await self._observe(run_id, with_coverage=True)
        if after is None:
            return _refusal(
                PassReceipt, "unknown_run", EXIT_USAGE, pass_metrics=measures
            )
        result, exit_code = _pass_result(stop, after.readiness)
        return after.receipt(
            PassReceipt,
            result=result,
            reason=stop,
            exit_code=exit_code,
            pass_metrics=measures,
        )

    async def _observed_pass(
        self, run_id: uuid.UUID, measures: BackfillPass
    ) -> PassReceipt:
        """A finished run does no body work: the pass reports it as it is now."""
        observation = await self._observe(run_id, with_coverage=True)
        result, reason, exit_code = observation.verdict()
        measures.stop_reason = reason
        return observation.receipt(
            PassReceipt,
            result=result,
            reason=reason,
            exit_code=exit_code,
            pass_metrics=measures,
        )

    async def _acquire_lease(self, run_id: uuid.UUID) -> int | None:
        """The new lease epoch, or None while another lease is live or the run
        has finished. Touches only the run, and commits before any work."""
        async with self.session_factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            run = await repo.lock_run(run_id)
            now = await repo.clock()
            if run is None or run.finished_at is not None or _lease_live(run, now):
                return None
            run.lease_epoch += 1
            run.lease_expires_at = now + LEASE_DURATION
            return run.lease_epoch


def _pass_result(stop: Reason, readiness: Readiness | None) -> tuple[Result, int]:
    if stop == "lease_lost":
        return "busy", EXIT_BUSY
    if stop == "retry_backoff":
        return "waiting", EXIT_BACKOFF
    if stop in FINISH_REASONS:
        if readiness == "ready_at_observation":
            return "finished", EXIT_OK
        return "finished", EXIT_UNREADY
    return "progress", EXIT_PROGRESS


class _Pass:
    """One bounded pass under one lease epoch. Every mutation re-checks the
    lease on the database clock after taking its locks; once that fails, the
    pass writes nothing more, not even a release."""

    def __init__(
        self,
        session_factory: async_sessionmaker,
        run_id: uuid.UUID,
        epoch: int,
        identity: RunIdentity,
        measures: BackfillPass,
    ):
        self.factory = session_factory
        self.run_id = run_id
        self.epoch = epoch
        self.identity = identity
        self.measures = measures
        self.io = ObjectReadAccounting()
        self.processor = SessionSearchObjectProcessor(session_factory)
        self.processed: set[tuple[str, uuid.UUID]] = set()
        self.due_claims: deque[_ClaimView] = deque()
        self.final_scope: _ScopeObservation | None = None

    async def run(self) -> Reason:
        try:
            stop = await self._work()
        except _LeaseLost:
            return "lease_lost"
        finally:
            self._record_io()
        if stop not in FINISH_REASONS:
            try:
                await self._release()
            except _LeaseLost:
                return "lease_lost"
        return stop

    async def release_after_failure(self) -> None:
        try:
            await self._release()
        except _LeaseLost:
            pass
        except Exception as error:
            # Never the failure's text: it may carry storage or SQL detail.
            logger.warning(
                "session search backfill kept its lease after a failure (%s)",
                type(error).__name__,
            )

    def _record_io(self) -> None:
        self.measures.stat_calls = self.io.stat_calls
        self.measures.read_calls = self.io.read_calls
        self.measures.requested_bytes = self.io.requested_bytes
        self.measures.returned_bytes = self.io.returned_bytes

    def _remaining(self) -> int:
        return self.measures.byte_budget - self.measures.reserved_bytes

    def _attempted(self, claim: _ClaimView, charged: int) -> None:
        self.processed.add(claim.key)
        self.measures.sources_attempted += 1
        self.measures.reserved_bytes += charged

    async def _work(self) -> Reason:
        while True:
            claim = await self._next_due_claim()
            if claim is not None:
                if self.measures.sources_attempted >= self.measures.source_limit:
                    return "source_limit"
                if not await self._process(claim):
                    return "byte_budget"
                continue
            stop = await self._advance()
            if stop is not None:
                return stop

    # --- the lease ---

    async def _fence(
        self, repo: SessionSearchBackfillRepository
    ) -> tuple[SessionSearchBackfillRun, datetime]:
        """Lock the run last and read the clock after the lock: a transaction
        that waited on any row lock judges the lease as of now, even when no
        successor has taken it yet."""
        run = await repo.lock_run(self.run_id)
        now = await repo.clock()
        if (
            run is None
            or run.finished_at is not None
            or run.lease_epoch != self.epoch
            or not _lease_live(run, now)
        ):
            raise _LeaseLost
        return run, now

    async def _renew(self) -> None:
        async with self.factory() as db, db.begin():
            run, now = await self._fence(SessionSearchBackfillRepository(db))
            run.lease_expires_at = now + LEASE_DURATION

    async def _release(self) -> None:
        async with self.factory() as db, db.begin():
            run, _ = await self._fence(SessionSearchBackfillRepository(db))
            run.lease_expires_at = None

    async def _finish(self, reason: Reason) -> Reason:
        """Finish and release together, before the lease is given up."""
        async with self.factory() as db, db.begin():
            run, now = await self._fence(SessionSearchBackfillRepository(db))
            run.phase = "finished"
            run.finished_at = now
            run.finish_reason = reason
            run.lease_expires_at = None
        return reason

    # --- claims ---

    async def _claims(self) -> tuple[list[_ClaimView], datetime]:
        async with self.factory() as db:
            repo = SessionSearchBackfillRepository(db)
            claims = [_ClaimView.of(claim) for claim in await repo.claims(self.run_id)]
            return claims, await repo.clock()

    async def _next_due_claim(self) -> _ClaimView | None:
        if not self.due_claims:
            claims, now = await self._claims()
            self.due_claims.extend(
                claim
                for claim in claims
                if claim.key not in self.processed and claim.due(now)
            )
        # Only scheduling views survive between sources. Processing still reads
        # current authorization and fences each settlement; refill sees due retries.
        return self.due_claims.popleft() if self.due_claims else None

    async def _process(self, claim: _ClaimView) -> bool:
        """Work one claimed source; False when it does not fit the budget left."""
        if claim.kind == "event":
            return await self._index_stored_source(claim)
        async with self.factory() as db:
            facts = await SessionSearchBackfillRepository(db).content_facts(
                claim.source_id
            )
        if facts is None:
            await self._settle(claim, "absent")
            return True
        # Current membership before any body is read; settlement checks it
        # again under the session lock.
        if not facts.member:
            await self._settle(claim, "owner_not_member")
            return True
        route = _processing_route(facts, self.identity)
        if route in ("stale", "invalid_metadata"):
            await self._settle(claim, route)
            return True
        if route == "inline":
            return await self._index_stored_source(claim)
        # The sentinel byte past the declared size is part of the request.
        reservation = facts.byte_count + 1
        if reservation > self._remaining():
            return False
        await self._renew()
        await self._prepare_object(claim, reservation)
        return True

    async def _settle(self, claim: _ClaimView, settlement: Settlement) -> None:
        async with self.factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            row = await repo.lock_claim(self.run_id, claim.kind, claim.source_id)
            if row is None:
                raise _LeaseLost
            run, now = await self._fence(repo)
            await self._apply(repo, run, row, now, settlement)
        self._attempted(claim, 0)

    async def _index_stored_source(self, claim: _ClaimView) -> bool:
        """An event or inline body: sized, written and acknowledged in one short
        transaction holding the session, then the content, then the claim,
        then the run."""
        try:
            async with self.factory() as db, db.begin():
                repo = SessionSearchBackfillRepository(db)
                settlement, size = await self._write_stored_source(db, repo, claim)
                row = await repo.lock_claim(self.run_id, claim.kind, claim.source_id)
                if row is None:
                    raise _LeaseLost
                run, now = await self._fence(repo)
                await self._apply(repo, run, row, now, settlement)
                run.lease_expires_at = now + LEASE_DURATION
        except _OverBudget:
            return False
        self._attempted(claim, size)
        return True

    async def _write_stored_source(
        self,
        db: AsyncSession,
        repo: SessionSearchBackfillRepository,
        claim: _ClaimView,
    ) -> tuple[Settlement, int]:
        search = SessionSearchRepository(db)
        if claim.kind == "event":
            session_id = await search.session_of_event(claim.source_id)
        else:
            session_id = await search.session_of_content(claim.source_id)
        session = await search.lock_session(session_id) if session_id else None
        if session is None:
            return "absent", 0
        # The writer's event and inline entry points do not check membership.
        if not await search.is_member(session.workspace_id, session.owner_id):
            return "owner_not_member", 0
        if (
            claim.kind == "content"
            and await repo.lock_content_metadata(claim.source_id) is None
        ):
            return "absent", 0
        # Membership can change while the content lock waits. The session lock
        # does not protect membership, so authorize again before reading bytes.
        if claim.kind == "content" and not await search.is_member(
            session.workspace_id, session.owner_id
        ):
            return "owner_not_member", 0
        # Measured in the database: neither a nullable legacy byte_count nor
        # an event's searchable leaves stand in for the persisted bytes.
        size = await repo.stored_bytes(claim.kind, claim.source_id)
        if size is None:
            return ("absent", 0) if claim.kind == "event" else ("changed", 0)
        if size > self._remaining():
            raise _OverBudget
        written = await SessionSearchIndexWriter(db).index_source(
            claim.kind, claim.source_id
        )
        if written == "ineligible":
            return "stale", size
        if written in ("pending", "stale"):
            return "changed", size
        return written, size

    async def _prepare_object(self, claim: _ClaimView, reservation: int) -> None:
        requested_before = self.io.requested_bytes
        # Outside any transaction: no lock or snapshot is held across storage.
        prepared = await self.processor.prepare_source(
            claim.source_id, max_requested_bytes=self._remaining(), io=self.io
        )
        try:
            await self._settle_prepared(claim, prepared)
        finally:
            # One prepared body at a time: none outlives its settlement.
            del prepared
            requested = self.io.requested_bytes - requested_before
            self._attempted(claim, max(reservation, requested))

    async def _settle_prepared(
        self, claim: _ClaimView, prepared: PreparedSource
    ) -> None:
        read, outcome = prepared.descriptor, prepared.outcome
        async with self.factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            if outcome in WRITER_SETTLED:
                # Locks session then content and writes nothing unless the
                # source is still exactly what was read and its owner a member.
                written = await SessionSearchIndexWriter(db).index_prepared_source(
                    prepared
                )
                settlement = {"ineligible": "owner_not_member", "stale": "changed"}.get(
                    written, written
                )
            elif outcome == "ineligible":
                settlement = (
                    "invalid_metadata"
                    if read is not None and _is_retained_text(read)
                    else "stale"
                )
            elif outcome == "stale":
                settlement = "changed"
            else:
                settlement = outcome
            row = await repo.lock_claim(self.run_id, claim.kind, claim.source_id)
            if row is None:
                raise _LeaseLost
            run, now = await self._fence(repo)
            await self._apply(repo, run, row, now, settlement, read, outcome)

    async def _apply(
        self,
        repo: SessionSearchBackfillRepository,
        run: SessionSearchBackfillRun,
        row: SessionSearchBackfillClaim,
        now: datetime,
        settlement: Settlement,
        read: ObjectDescriptor | None = None,
        prepared_outcome: str | None = None,
    ) -> None:
        """Acknowledge a claim and count it, in the settlement's transaction."""
        if settlement in ("changed", "budget_deferred"):
            _retain(row, read)
            row.state, row.next_attempt_at = "pending", None
            row.reason = "stale" if settlement == "changed" else "budget_deferred"
            if settlement == "changed":
                _count(run, stale=1)
            return
        verification = (
            _verification_increments(prepared_outcome, read)
            if run.phase == "verify_unavailable" and prepared_outcome is not None
            else {}
        )
        if settlement == "storage_unavailable":
            _retain(row, read)
            row.attempts += 1
            row.reason = "storage_unavailable"
            if row.attempts >= MAX_STORAGE_ATTEMPTS:
                # Kept, so no later sweep can reset its attempts.
                row.state, row.next_attempt_at = "exhausted", None
                _count(run, exhausted=1, **verification)
            else:
                row.state = "retry_wait"
                row.next_attempt_at = now + _retry_delay(row.attempts)
                _count(run, retry_wait=1, **verification)
            return
        await repo.delete_claim(self.run_id, row.source_kind, row.source_id)
        _count(run, **{settlement: 1}, **verification)

    # --- scans and phases ---

    async def _advance(self) -> Reason | None:
        """Admit or settle more work; a stop reason once this pass can do no
        more."""
        if self.measures.sources_attempted >= self.measures.source_limit:
            return "source_limit"
        async with self.factory() as db:
            run = await SessionSearchBackfillRepository(db).run(self.run_id)
            if run is None:
                raise _LeaseLost
            phase = run.phase
            content_done, event_done = run.content_exhausted, run.event_exhausted
        verifying = phase == "verify_unavailable"
        if not content_done:
            return await self._scan("content", verifying=verifying)
        if verifying:
            claims, now = await self._claims()
            unresolved = [claim for claim in claims if claim.state != "exhausted"]
            if unresolved:
                return _waiting(unresolved, now)
            await self._begin_sweep(discovery=True)
            return None
        if not event_done:
            return await self._scan("event", verifying=False)
        return await self._end_of_sweep()

    async def _scan(self, kind: str, *, verifying: bool) -> Reason | None:
        allowance = MAX_PASS_CANDIDATE_KEYS - self.measures.candidate_keys_examined
        if allowance <= 0:
            return "candidate_limit"
        async with self.factory() as db:
            repo = SessionSearchBackfillRepository(db)
            run = await repo.run(self.run_id)
            if run is None:
                raise _LeaseLost
            cursor = getattr(run, f"{kind}_cursor")
            upper = getattr(run, f"{kind}_upper")
            if kind == "content":
                candidates = await repo.content_candidates(
                    after=cursor,
                    upper=upper,
                    limit=allowance,
                    recorded_unavailable_in=EXTRACTOR_VERSION if verifying else None,
                )
            else:
                candidates = await repo.event_candidates(
                    after=cursor, upper=upper, limit=allowance
                )
            claims = await repo.claims(self.run_id)
        self.measures.candidate_keys_examined += len(candidates)
        claimed = {(claim.source_kind, claim.source_id) for claim in claims}
        admitted: list[dict] = []
        counts: Counter[str] = Counter()
        blocked: str | None = None
        scanned_to = cursor
        for candidate in candidates:
            if kind == "content":
                verdict = _content_verdict(
                    candidate, self.identity, verifying=verifying
                )
            else:
                verdict = _event_verdict(candidate, self.identity)
            if verdict == "eligible" and (kind, candidate.id) not in claimed:
                # The cursor stays before an eligible source this pass cannot
                # claim, so no budget boundary ever skips one.
                if self.measures.sources_attempted + len(admitted) >= (
                    self.measures.source_limit
                ):
                    blocked = "source_limit"
                    break
                if len(claims) + len(admitted) >= MAX_RUN_CLAIMS:
                    blocked = "slots_full"
                    break
                admitted.append(_claim_row(self.run_id, kind, candidate))
            elif verdict in ("owner_not_member", "invalid_metadata"):
                counts[verdict] += 1
            scanned_to = candidate.id
        exhausted = blocked is None and len(candidates) < allowance
        if scanned_to != cursor or exhausted:
            async with self.factory() as db, db.begin():
                repo = SessionSearchBackfillRepository(db)
                # Claims and the cursor past them commit together.
                if admitted:
                    await repo.insert_claims(admitted)
                run, _ = await self._fence(repo)
                setattr(run, f"{kind}_cursor", scanned_to)
                if exhausted:
                    setattr(run, f"{kind}_exhausted", True)
                if counts:
                    _count(run, **counts)
        if blocked == "slots_full" and not admitted:
            return await self._slots_full()
        return None

    async def _slots_full(self) -> Reason:
        """All 25 claims are held. Exhausted ones never free their slot, so a
        run whose every slot is exhausted finishes unready, its discovery
        recorded incomplete."""
        claims, now = await self._claims()
        unresolved = [claim for claim in claims if claim.state != "exhausted"]
        if not unresolved:
            return await self._finish("claims_exhausted")
        return _waiting(unresolved, now)

    async def _begin_sweep(self, *, discovery: bool) -> None:
        """Restart both scans from the beginning, each bounded by the newest id
        it has now: a finite interval, not a snapshot of the corpus."""
        async with self.factory() as db, db.begin():
            repo = SessionSearchBackfillRepository(db)
            run, now = await self._fence(repo)
            if discovery:
                run.phase = "discover"
                run.verification_finished_at = now
            else:
                run.phase = "reconcile"
                run.sweep += 1
            content_upper = await repo.last_content_id()
            event_upper = await repo.last_event_id()
            run.content_cursor = run.event_cursor = None
            run.content_upper, run.event_upper = content_upper, event_upper
            run.content_exhausted = content_upper is None
            run.event_exhausted = event_upper is None

    async def _end_of_sweep(self) -> Reason | None:
        claims, now = await self._claims()
        unresolved = [claim for claim in claims if claim.state != "exhausted"]
        if await self._has_unclaimed_work(claims):
            if len(claims) < MAX_RUN_CLAIMS:
                await self._begin_sweep(discovery=False)
                return None
            if not unresolved:
                return await self._finish("claims_exhausted")
            return _waiting(unresolved, now)
        if unresolved:
            return _waiting(unresolved, now)
        async with self.factory() as db:
            scope = await _scope_coverage(
                SessionSearchBackfillRepository(db), self.identity
            )
        if claims:
            # A finalization can commit between the first eligibility read and
            # coverage. Exhausted claims must not strand new work in free slots.
            if len(claims) < MAX_RUN_CLAIMS and await self._has_unclaimed_work(claims):
                await self._begin_sweep(discovery=False)
                return None
            reason = "claims_exhausted"
        elif scope.settled:
            reason = "clean_observation"
        elif scope.unresolved_metadata and not await self._has_unclaimed_work(claims):
            reason = "unresolved_metadata"
        else:
            # Finalization or restored membership can add work between the
            # earlier eligibility read and this coverage observation. Pending
            # work is another bounded sweep, never an invented metadata fault.
            await self._begin_sweep(discovery=False)
            return None
        finished = await self._finish(reason)
        # Publish this observation only after our finish fence commits. A lost
        # worker must not pair its earlier aggregate with another worker's run.
        self.final_scope = scope
        return finished

    async def _has_unclaimed_work(self, claims: list[_ClaimView]) -> bool:
        claimed = {kind: set() for kind in ("content", "event")}
        for claim in claims:
            claimed[claim.kind].add(claim.source_id)
        async with self.factory() as db:
            repo = SessionSearchBackfillRepository(db)
            return await repo.has_unclaimed_content(
                extractor_version=self.identity.extractor_version,
                claimed=claimed["content"],
                backend=self.identity.store_backend,
                max_body_bytes=MAX_TEXT_BODY_BYTES,
            ) or await repo.has_unclaimed_event(
                extractor_version=self.identity.extractor_version,
                claimed=claimed["event"],
            )


def _retain(row: SessionSearchBackfillClaim, read: ObjectDescriptor | None) -> None:
    """Keep a claim for a later pass, bound to the descriptor just read. A new
    digest is a new identity: its storage attempts start over."""
    if read is None:
        return
    if row.expected_digest != read.sha256:
        row.attempts = 0
    row.expected_digest = read.sha256
    row.descriptor_fingerprint = _descriptor_fingerprint(read)
    if read.byte_count is not None and read.inline_text is None:
        row.reserved_bytes = read.byte_count + 1


def _waiting(unresolved: list[_ClaimView], now: datetime) -> Reason:
    """Every due claim was already worked this pass, or none is due yet."""
    if any(claim.due(now) for claim in unresolved):
        return "claims_pending"
    return "retry_backoff"
