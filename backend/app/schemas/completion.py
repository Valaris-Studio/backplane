# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import binascii
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


class CompletionSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CompletionCheck(CompletionSchema):
    id: str = Field(min_length=1, max_length=128)
    argv: list[str] = Field(min_length=1, max_length=128)
    timeout_seconds: int = Field(default=300, ge=1, le=3600)

    @model_validator(mode="after")
    def valid_argv(self):
        if not self.argv[0].strip() or any("\x00" in value for value in self.argv):
            raise ValueError(
                "Checks require a nonempty executable and NUL-free arguments"
            )
        return self


class PostmergeValidation(CompletionSchema):
    role: str = Field(min_length=1, max_length=64)
    checks: list[CompletionCheck] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def distinct_checks(self):
        if len({check.id for check in self.checks}) != len(self.checks):
            raise ValueError("Check ids must be unique")
        return self


class EvidenceOnlyPolicy(CompletionSchema):
    enabled: bool = False
    approval: Literal["none", "independent"] = "none"
    review_role: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def independent_role(self):
        if self.enabled and self.approval == "independent" and not self.review_role:
            raise ValueError("Independent evidence approval requires a configured role")
        return self


class CompletionPolicyV1(CompletionSchema):
    version: Literal[1] = 1
    landing_actor: Literal["agent", "platform", "human"]
    landing_methods: list[Literal["merge_queue", "external"]] = Field(min_length=1)
    source_review: Literal["none", "independent"] = "none"
    review_role: str | None = Field(default=None, min_length=1, max_length=64)
    require_forge_checks: bool = False
    postmerge_validation: PostmergeValidation | None = None
    evidence_only: EvidenceOnlyPolicy = Field(default_factory=EvidenceOnlyPolicy)
    dependency_release: Literal["done", "accepted"] = "done"
    auto_complete: bool = True

    @model_validator(mode="after")
    def supported_combination(self):
        if len(set(self.landing_methods)) != len(self.landing_methods):
            raise ValueError("Landing methods must be unique")
        if self.source_review == "independent" and not self.review_role:
            raise ValueError("Independent source review requires a configured role")
        if self.landing_actor != "human" and "external" in self.landing_methods:
            raise ValueError(
                "Autonomous landing supports the platform merge queue; external landing requires a human"
            )
        if self.landing_actor == "human" and "merge_queue" in self.landing_methods:
            raise ValueError(
                "Human landing uses external; select agent or platform for the merge queue"
            )
        return self


CompletionMode = Literal["source", "evidence_only"]


class CompletionPolicyWrite(CompletionSchema):
    policy: CompletionPolicyV1 | None


class CompletionTemplatePreview(CompletionSchema):
    source: Literal["system", "workspace"]
    ref: str = Field(min_length=1)
    version: int = Field(ge=1)
    slot_values: dict = Field(default_factory=dict)


class CompletionPolicyPreview(CompletionPolicyWrite):
    loop_config: dict | None = None
    template: CompletionTemplatePreview | None = None


class CompletionModeWrite(CompletionSchema):
    completion_mode: CompletionMode


class CompletionArtifact(CompletionSchema):
    name: str = Field(min_length=1, max_length=255)
    uri: str = Field(min_length=1, max_length=2000)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class CompletionCheckResult(CompletionSchema):
    id: str = Field(min_length=1, max_length=128)
    source_sha: str = Field(pattern=r"^[a-f0-9]{40}([a-f0-9]{24})?$")
    exit_code: int = Field(ge=-255, le=255)
    output: str = Field(default="", max_length=16384)


class CompletionSubmit(CompletionSchema):
    source_execution_id: uuid.UUID
    source_sha: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{40}([a-f0-9]{24})?$"
    )
    artifacts: list[CompletionArtifact] = Field(default_factory=list, max_length=50)
    checks: list[CompletionCheckResult] = Field(default_factory=list, max_length=50)


class CompletionCapabilities(CompletionSchema):
    providers: list[str] = Field(default_factory=list, max_length=100)
    exact_checkout: bool = False
    argv_checks: bool = False


class CompletionClaim(CompletionSchema):
    capabilities: CompletionCapabilities


class CompletionResult(CompletionSchema):
    lease_token: str = Field(min_length=1, max_length=255)
    candidate_id: uuid.UUID
    policy_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    contract_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_sha: str = Field(pattern=r"^[a-f0-9]{40}([a-f0-9]{24})?$")
    outcome: Literal["passed", "failed"]
    failure_class: Literal["execution"] | None = None
    checks: list[CompletionCheckResult] = Field(default_factory=list, max_length=50)
    summary: str = Field(min_length=1, max_length=16384)
    artifacts: list[CompletionArtifact] = Field(default_factory=list, max_length=50)
    tokens_used: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0, ge=0, allow_inf_nan=False)
    duration_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def failure_class_requires_failed_outcome(self):
        if self.failure_class is not None and self.outcome != "failed":
            raise ValueError("A failure classification requires a failed outcome")
        return self


class CompletionRework(CompletionSchema):
    candidate_id: uuid.UUID
    failed_attempt_id: uuid.UUID
    source_execution_id: uuid.UUID


class CompletionReworkWork(CompletionSchema):
    candidate_id: uuid.UUID
    card_id: uuid.UUID
    failed_attempt_id: uuid.UUID
    execution_id: uuid.UUID
    context: str


class CompletionReworkResponse(CompletionSchema):
    work: CompletionReworkWork | None


class CompletionLand(CompletionSchema):
    method: Literal["merge_queue"] = "merge_queue"


class CompletionRequirement(CompletionSchema):
    kind: Literal["review", "evidence_review", "validation"]
    role: str
    provider: str
    model: str
    checks: list[CompletionCheck]
    tool_policy: dict[str, list[str]]


class CompletionRequirements(CompletionSchema):
    policy_hash: str | None
    requirements: list[CompletionRequirement]


class CompletionReadinessCheck(CompletionSchema):
    operation: Literal[
        "repository_binding", "repository_read", "pull_requests_read",
        "candidate_pr_read", "forge_write",
    ]
    repo_id: uuid.UUID | None = None
    candidate_id: uuid.UUID | None = None
    required: bool
    status: Literal["verified", "failed", "unverified"]
    code: Literal[
        "verified", "repository_required", "credential_unavailable",
        "credential_host_mismatch", "forge_unsupported", "forge_auth_failed",
        "forge_not_found", "forge_unavailable", "forge_response_invalid",
        "readiness_timeout", "write_unverified", "candidate_changed",
    ]
    credential_source: Literal["workspace_connection", "platform"] | None = None
    connection_id: uuid.UUID | None = None


class CompletionReadiness(CompletionSchema):
    policy_hash: str | None
    ready: bool
    checks: list[CompletionReadinessCheck]


class CompletionWorkAttempt(CompletionSchema):
    id: uuid.UUID
    status: str
    kind: str
    role: str
    provider: str
    model: str
    expires_at: datetime
    lease_state: Literal["active", "expired", "closed"]


class CompletionWorkFailure(CompletionSchema):
    code: str
    retryable: bool


class CompletionWorkflow(CompletionSchema):
    card_id: uuid.UUID
    candidate_id: uuid.UUID
    phase: str
    source_sha: str
    merge_sha: str | None
    policy_hash: str
    attempt: CompletionWorkAttempt | None
    failure: CompletionWorkFailure | None
    next_action: str
    summary: str = Field(max_length=1024)


def encode_work_cursor(priority: int, card_id: uuid.UUID) -> str:
    return (
        base64.urlsafe_b64encode(f"1:{priority}:{card_id}".encode())
        .decode()
        .rstrip("=")
    )


def decode_work_cursor(value: str) -> tuple[int, uuid.UUID]:
    try:
        version, priority, card = (
            base64.b64decode(
                value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
            )
            .decode()
            .split(":")
        )
        rank, card_id = int(priority), uuid.UUID(card)
        if (
            version != "1"
            or rank not in (0, 1, 2)
            or encode_work_cursor(rank, card_id) != value
        ):
            raise ValueError
    except (ValueError, UnicodeError, binascii.Error) as exc:
        raise ValueError("Invalid completion work cursor") from exc
    return rank, card_id


def validate_work_cursor(value: str) -> str:
    decode_work_cursor(value)
    return value


CompletionWorkCursor = Annotated[
    str, Field(max_length=64), AfterValidator(validate_work_cursor)
]


class CompletionWorkStatus(CompletionSchema):
    rework_count: int = 0
    pending_count: int
    actionable_count: int
    failed_count: int
    revision: str
    workflows: list[CompletionWorkflow]
    next_cursor: CompletionWorkCursor | None
