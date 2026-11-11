# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Operational receipts of the session search backfill.

A receipt is safe to print and to keep: counts, sizes, timestamps, run ids
and allowlisted reasons only, never a body, query, source or session id,
storage location or exception text. Cumulative outcome counts describe what
the run did, not the current corpus; `coverage` is the current denominator,
and `readiness` is null whenever no fresh coverage could be trusted."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import ConfigDict, Field

from app.core.json_response import UTCModel
from app.schemas.session_search import CoverageCount

RECEIPT_SCHEMA = "session-search-backfill/1"

Command = Literal["start", "pass", "status"]
Result = Literal[
    "created",
    "existing",
    "progress",
    "waiting",
    "finished",
    "observed",
    "busy",
    "refused",
    "failed",
]
Reason = Literal[
    "created",
    "existing",
    "in_progress",
    "source_limit",
    "byte_budget",
    "candidate_limit",
    "claims_pending",
    "retry_backoff",
    "clean_observation",
    "claims_exhausted",
    "unresolved_metadata",
    "pending_since_finish",
    "lease_busy",
    "lease_live",
    "lease_lost",
    "configuration_mismatch",
    "feature_disabled",
    "schema_missing",
    "unknown_run",
    "run_superseded",
    "supersede_mismatch",
    "invalid_scope",
    "invalid_limits",
    "usage",
    "unexpected_failure",
]
Readiness = Literal["in_progress", "ready_at_observation", "exhausted_unready"]


class BackfillRun(UTCModel):
    id: uuid.UUID
    scope: str
    extractor_version: str
    store_fingerprint: str
    phase: str
    sweep: int
    # Whether this very command created the run.
    created: bool
    predecessor_id: uuid.UUID | None
    successor_id: uuid.UUID | None
    lease_epoch: int
    lease_expires_at: datetime | None
    created_at: datetime
    finished_at: datetime | None
    finish_reason: str | None


class BackfillOutcomes(UTCModel):
    indexed: int = 0
    unchanged: int = 0
    unavailable: int = 0
    not_text: int = 0
    absent: int = 0
    stale: int = 0
    owner_not_member: int = 0
    invalid_metadata: int = 0
    retry_wait: int = 0
    exhausted: int = 0


class BackfillClaims(UTCModel):
    # Every claim the run holds, exhausted ones included (at most 25).
    outstanding: int
    due: int
    exhausted: int
    # The earliest retry a delayed claim waits for.
    next_attempt_at: datetime | None


class BackfillProgress(UTCModel):
    outcomes: BackfillOutcomes
    claims: BackfillClaims
    # The current discovery or reconciliation sweep reached its upper bound.
    discovery_complete: bool
    verification_complete: bool


class BackfillPass(UTCModel):
    source_limit: int
    byte_budget: int
    sources_attempted: int = 0
    candidate_keys_examined: int = 0
    # Budget charged: an object's declared size plus its sentinel byte (or
    # what it actually requested, if more), an inline body's or event's
    # persisted UTF-8 bytes.
    reserved_bytes: int = 0
    requested_bytes: int = 0
    returned_bytes: int = 0
    stat_calls: int = 0
    read_calls: int = 0
    stop_reason: Reason | None = None


class BackfillCoverage(UTCModel):
    """Every retained source whose session owner is still a member of the
    session's workspace, in the session search's own buckets, from one
    aggregate. `index_ready` keeps its meaning there: nothing is pending
    index. Sources of non-members are only counted."""

    indexed: CoverageCount
    pending_index: CoverageCount
    pending_upload: CoverageCount
    withheld: CoverageCount
    uncaptured: CoverageCount
    unavailable: CoverageCount
    nontext: CoverageCount
    available: CoverageCount
    eligible: CoverageCount
    eligible_count: int
    child_metadata_count: int
    owner_not_member_count: int
    index_ready: bool
    extractor_version: str
    observed_from: datetime
    observed_at: datetime


class BackfillVerification(UTCModel):
    """This run's finite sweep over objects already recorded unavailable. It
    observes those objects only; it never confirms the whole store."""

    # The run: its id is the epoch.
    epoch_id: uuid.UUID
    started_at: datetime | None
    finished_at: datetime | None
    # Committed object probes, including retry attempts; not unique identities.
    # Outcome counters below describe those probes. Coverage counts are unique.
    attempted_objects: int
    hash_verified_objects: int
    hash_verified_bytes: int
    missing_objects: int
    mismatch_objects: int
    storage_errors: int


class BackfillReceipt(UTCModel):
    # Aliased names (`schema`, `pass`) are what any JSON form carries.
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    schema_: Literal["session-search-backfill/1"] = Field(
        RECEIPT_SCHEMA, alias="schema"
    )
    command: Command | None
    result: Result
    exit_code: int
    reason: Reason
    observed_at: datetime
    run: BackfillRun | None = None
    progress: BackfillProgress | None = None
    coverage: BackfillCoverage | None = None
    verification: BackfillVerification | None = None
    readiness: Readiness | None = None


class StartReceipt(BackfillReceipt):
    command: Literal["start"] = "start"


class StatusReceipt(BackfillReceipt):
    command: Literal["status"] = "status"


class PassReceipt(BackfillReceipt):
    command: Literal["pass"] = "pass"
    pass_metrics: BackfillPass = Field(alias="pass")
