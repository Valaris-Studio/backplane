# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import field_validator

from app.core.json_response import UTCModel
from app.schemas.git.git_repo import validate_branch_name


class MergeQueueEnqueueRequest(UTCModel):
    card_id: uuid.UUID
    repo_id: uuid.UUID
    pr_url: str
    pr_branch: str
    # Optional: when omitted, the service falls back to repo.integration_branch.
    integration_branch: str | None = None

    # These take precedence over the repo's own branches and reach `git push` /
    # `git merge` as bare argv, where `--receive-pack=cmd` makes git spawn
    # `/bin/sh -c cmd`. Same validator as the repo schema — this is the second
    # ingress for a branch name, not a different kind of value.
    @field_validator("pr_branch", "integration_branch")
    @classmethod
    def _check_branch(cls, v: str | None) -> str | None:
        return validate_branch_name(v)


class MergeQueueReEnqueueRequest(UTCModel):
    """PAR-3c: re-queue an existing entry by its parent card_id.

    The consolidator pipeline calls this once it has resolved the conflict;
    the worker then re-attempts the merge. No repo / pr fields — the entry
    already has them.
    """

    card_id: uuid.UUID


class MergeQueueEntryRead(UTCModel):
    id: uuid.UUID
    repo_id: uuid.UUID
    integration_branch: str
    card_id: uuid.UUID
    pr_url: str
    pr_branch: str
    workspace_id: uuid.UUID
    enqueued_at: datetime
    # The FIFO position (`enqueued_at`) is bumped to the back of the queue on
    # every retry, so clients cannot derive stuck-duration from it. This is the
    # origin clock. NULL for rows predating migration 088.
    first_enqueued_at: datetime | None = None
    state: str
    attempt_count: int
    error_message: str | None = None
    merged_at: datetime | None = None

    model_config = {"from_attributes": True}
