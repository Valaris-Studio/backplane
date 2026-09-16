# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from math import isfinite
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from app.schemas.completion import CompletionPolicyV1
from app.schemas.completion_context import CompletionContextSize

from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS


logger = logging.getLogger(__name__)

LoopDisabledReasonCode = Literal[
    "max_iterations_reached",
    "budget_exhausted",
    "consecutive_failures",
]

_REASON_PARAM_KEYS: dict[str, frozenset[str]] = {
    "max_iterations_reached": frozenset({"max_iterations"}),
    "budget_exhausted": frozenset({"spent_usd", "budget_usd"}),
    "consecutive_failures": frozenset({"count"}),
}


def _validate_known_reason_params(
    reason_code: str, reason_params: dict[str, object]
) -> None:
    expected_keys = _REASON_PARAM_KEYS[reason_code]
    if reason_params.keys() != expected_keys:
        raise ValueError(f"{reason_code} requires exactly {sorted(expected_keys)}")

    if reason_code == "budget_exhausted":
        if any(
            type(value) not in (int, float)
            or (type(value) is float and not isfinite(value))
            for value in reason_params.values()
        ):
            raise ValueError("budget_exhausted params must be finite numbers")
        spent_usd = reason_params["spent_usd"]
        budget_usd = reason_params["budget_usd"]
        if spent_usd < 0 or budget_usd <= 0 or spent_usd < budget_usd:
            raise ValueError("budget_exhausted requires spent_usd >= budget_usd > 0")
        return

    if any(
        type(value) is not int
        and not (type(value) is float and isfinite(value) and value.is_integer())
        for value in reason_params.values()
    ):
        raise ValueError(f"{reason_code} params must be integers")
    if any(value <= 0 for value in reason_params.values()):
        raise ValueError(f"{reason_code} params must be greater than zero")


def _legacy_reason_for_known_code(
    reason_code: str, reason_params: dict[str, object] | None
) -> str | None:
    if reason_params is None:
        return None
    try:
        _validate_known_reason_params(reason_code, reason_params)
    except ValueError:
        return None

    if reason_code == "max_iterations_reached":
        return f"max_iterations reached ({int(reason_params['max_iterations'])})"
    if reason_code == "budget_exhausted":
        return (
            "budget_usd exhausted "
            f"(${reason_params['spent_usd']:.2f} of "
            f"${reason_params['budget_usd']:.2f})"
        )
    return f"{int(reason_params['count'])} consecutive failed iterations"



class LoopConfigRead(BaseModel):
    """The complete wire object — every field always present.

    The runner json.Unmarshals this without defaults, so a missing numeric
    would decode as 0 and trip a safety rail. `updated_at` is served verbatim
    as the stored ISO string.
    """

    # `model` is a domain field (tier alias or concrete id), not a pydantic
    # namespace clash worth renaming over.
    model_config = {"protected_namespaces": ()}

    enabled: bool = LOOP_CONFIG_DEFAULTS["enabled"]
    completion_policy: dict | None = None
    completion_policy_hash: str | None = None
    completion_context: str = ""
    completion_context_size: CompletionContextSize | None = None
    provider: str = LOOP_CONFIG_DEFAULTS["provider"]
    model: str = LOOP_CONFIG_DEFAULTS["model"]
    system_prompt: str = LOOP_CONFIG_DEFAULTS["system_prompt"]
    loop_prompt: str = LOOP_CONFIG_DEFAULTS["loop_prompt"]
    tools: list[str] = []
    max_iterations: int = LOOP_CONFIG_DEFAULTS["max_iterations"]
    iteration_delay_seconds: int = LOOP_CONFIG_DEFAULTS["iteration_delay_seconds"]
    iteration_timeout_seconds: int = LOOP_CONFIG_DEFAULTS["iteration_timeout_seconds"]
    budget_usd: float = LOOP_CONFIG_DEFAULTS["budget_usd"]
    max_consecutive_failures: int = LOOP_CONFIG_DEFAULTS["max_consecutive_failures"]
    max_blocked_on_human: int = LOOP_CONFIG_DEFAULTS["max_blocked_on_human"]
    starvation_policy: str = LOOP_CONFIG_DEFAULTS["starvation_policy"]
    loop_landing: str = LOOP_CONFIG_DEFAULTS["loop_landing"]
    merge_gate: str = LOOP_CONFIG_DEFAULTS["merge_gate"]
    # Served explicitly because the runner decodes a missing bool as false —
    # relying on a Go-side default would flip proposals off for every board
    # saved before this field existed.
    skills_proposal_enabled: bool = LOOP_CONFIG_DEFAULTS["skills_proposal_enabled"]
    # {label, exclude_column_type} or null (off). The runner evaluates it in
    # code before spawning a session — see docs/loop-mode-contract.md.
    completion_query: dict | None = LOOP_CONFIG_DEFAULTS["completion_query"]
    # Server-owned (like version/updated_at): stamped on every
    # disabled→enabled transition. The runner sums spent-since-epoch from it.
    budget_epoch: str | None = None
    disabled_reason: str | None = None
    # Reads are deliberately open so a newer runner/backend code remains a
    # 200 response and older frontends can show disabled_reason verbatim.
    # LoopStatePatch below remains the closed write boundary.
    disabled_reason_code: str | None = None
    disabled_reason_params: dict[str, object] | None = None
    disabled_diagnostic: str | None = None
    version: int = 1
    updated_at: str | None = None
    # The slim ref for a template-bound board, null when the prompts are raw.
    # {source, ref, version, drift: {kind, current_version?}} — deliberately
    # NOT the slot values: the runner json.Unmarshals this object and has no
    # field for authoring state (that lives on GET /loop/binding). The runner
    # ignores the key entirely; it exists so the UI can render "bound to X"
    # without a second request.
    template: dict | None = None

    @model_validator(mode="after")
    def discard_stale_known_reason_metadata(self):
        reason_code = self.disabled_reason_code
        if reason_code not in _REASON_PARAM_KEYS:
            return self

        expected_legacy_reason = _legacy_reason_for_known_code(
            reason_code, self.disabled_reason_params
        )
        if expected_legacy_reason != self.disabled_reason:
            logger.warning(
                "Discarding stale known loop reason metadata for %s",
                reason_code,
            )
            self.disabled_reason_code = None
            self.disabled_reason_params = None
            self.disabled_diagnostic = None
        return self


class LoopReadinessRead(BaseModel):
    """Board-level starvation probe (GET /loop/readiness).

    A pure board read — served even before the board's first PUT /loop, so the
    runner's pre-flight can never confuse "nothing configured" (404, fatal on
    GET /loop) with "nothing to do" (actionable=false here).
    """

    ready_count: int
    blocked_count: int
    explicitly_blocked_count: int = 0
    explicitly_blocked_card_ids: list[uuid.UUID] = Field(default_factory=list)
    awaiting_merge_count: int
    review_open_pr_count: int
    actionable: bool
    pending_completion: int = 0
    failed_completion: int = 0


class LoopHistoryRead(BaseModel):
    """Cross-run continuity aggregate (GET /loop/history).

    iteration_count is ALL-TIME (numbering stays monotonic across the
    board's life); spent_usd sums structured cost_usd SINCE budget_epoch
    (all-time when null — conservative). Aggregated server-side because the
    executions list endpoint is limit-capped and a lower-bound sum on money
    would under-enforce the budget rail.
    """

    iteration_count: int
    spent_usd: float
    # Recorded cost combines provider reports and runner estimates; it is
    # not an invoice total and does not distinguish subscription billing.
    lifetime_spent_usd: float
    budget_epoch: str | None


class LoopStatusRead(BaseModel):
    """Loop truth layer (GET /loop/status).

    One answer to "what is the loop actually doing right now?" — config,
    in-flight iterations, and bound-agent liveness stitched server-side so the
    frontend never has to. Unconfigured IS a state (`off`), never a 404: the
    dashboard must render every board's loop state without special-casing.

    state: off (config absent or disabled — wins even over an in-flight
    iteration), running (in-flight loop_iteration on this board), parked
    (a bound, alive agent last heartbeated loop_state=parked FOR THIS BOARD),
    waiting (enabled + a bound agent alive), unattended (enabled + nobody
    alive). Parked outranks waiting but never off or running, and expires with
    the reporting agent's liveness — that is what keeps parked distinguishable
    from a runner that simply died.
    Bound = member of an AgentTeam with this board_id — never derived from
    health_current_board_id (that's an agent passing through, not a binding).
    """

    state: str
    enabled: bool
    disabled_reason: str | None
    # The last stop from the durable transition timeline. Unlike
    # disabled_reason it SURVIVES a re-enable, which is the whole point: the
    # chip must still be able to explain why the previous run ended while the
    # next one is already turning. Null only when the board has never stopped.
    last_stop_reason: str | None = None
    last_stop_at: str | None = None
    # Non-null ONLY in state=parked: the runner's own account of why it is
    # asleep, carried on its heartbeat. Present as null in every other state
    # so the key never appears or disappears from the wire object.
    park_reason: str | None = None
    actionable: bool
    has_inflight_iteration: bool
    last_iteration_at: str | None
    last_iteration_status: str | None
    bound_agent_count: int
    alive_agent_count: int
    spent_usd: float
    budget_usd: float | None


class LoopConfigPut(BaseModel):
    """Merge onto the board's stored config: exactly the operator fields plus
    the optimistic lock.

    extra="forbid" rejects unknown keys (typo protection — a silently dropped
    `max_iteration` would leave the real cap at its default) AND the
    server-owned stop metadata fields and updated_at, which are never
    accepted from clients. Omitted fields (and explicit JSON nulls — both
    decode to None here) inherit the board's CURRENT value via
    canonicalize_loop_config; only the first-ever PUT for a board has no
    stored config to inherit from and sees the documented defaults instead.
    Bounds live in loop_config_validation.

    `version` is the one server-owned key a client MAY send, because GET /loop
    returns it and the natural round-trip is to hand it straight back: it is
    accepted as an alias for `expected_version` (R14 friction log, card
    d8cbbec6). Both names mean the same optimistic-lock precondition and are
    normalized to `expected_version` before the service sees the body, so the
    alias is read as a precondition and never stored — the server's counter
    stays authoritative. Sending both with DIFFERENT values is rejected rather
    than silently resolved: picking a winner could skip the lock the caller
    thought they had.
    """

    model_config = {"extra": "forbid", "protected_namespaces": ()}

    enabled: bool | None = None
    completion_policy: CompletionPolicyV1 | None = None
    provider: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    loop_prompt: str | None = None
    tools: list[str] | None = None
    max_iterations: int | None = None
    iteration_delay_seconds: int | None = None
    iteration_timeout_seconds: int | None = None
    budget_usd: float | None = None
    max_consecutive_failures: int | None = None
    max_blocked_on_human: int | None = None
    starvation_policy: str | None = None
    loop_landing: str | None = None
    merge_gate: str | None = None
    skills_proposal_enabled: bool | None = None
    # Shape validated in loop_config_validation, not here: an empty object is
    # meaningful (the clear lever), so a stricter model would reject it.
    completion_query: dict | None = None
    # Bind / re-render / detach, mirroring completion_query's three-state
    # convention exactly: {...} sets, {} clears, null (or absent) leaves the
    # board's binding alone. Typed as a bare dict for the same reason
    # completion_query is — an empty object is the CLEAR lever, and a model
    # with required fields would reject it as malformed.
    template: dict | None = None
    # Request-scoped signal, never stored: a human self_merge save un-arms
    # the board's done-merge gate by default, so false is the DECLINE (keep
    # it armed for this save) and true the legacy explicit consent. Kept off
    # the config dict on purpose — the runner json.Unmarshals a fixed wire
    # shape, and a one-shot signal is not a loop knob to inherit on the next
    # PUT.
    relax_done_merge_gate: bool | None = None
    expected_version: int | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_version_as_lock_alias(cls, data):
        """Fold the read-shaped `version` key into `expected_version`.

        Runs before field validation so `version` never reaches extra="forbid".
        Only dict bodies are rewritten — model/kwargs construction paths pass
        through untouched.
        """
        if not isinstance(data, dict) or "version" not in data:
            return data

        rewritten = dict(data)
        alias = rewritten.pop("version")
        canonical = rewritten.get("expected_version")
        if canonical is not None and alias is not None and canonical != alias:
            raise ValueError(
                "version and expected_version disagree "
                f"({alias} vs {canonical}); send one, or send equal values"
            )
        if alias is not None:
            rewritten["expected_version"] = alias
        return rewritten


class LoopTemplateRead(BaseModel):
    """One loop-template catalog entry — exactly the wire keys, no extras.

    `tools` carries the full MCP ids the loop config stores
    (mcp__valaris__...), matching what PUT /loop and the ToolPicker use.

    `has_slots` marks a template whose prompts carry `<<SLOT>>`s. Copying one
    into the raw loop dialog would 422 (`unrendered_slot`) at save, so clients
    that lack the bind step must not offer it as directly applicable.
    """

    id: str
    name: str
    description: str
    system_prompt: str
    loop_prompt: str
    tools: list[str]
    has_slots: bool


class LoopTemplateCatalogMeta(BaseModel):
    """Catalog-wide facts a client would otherwise have to hardcode.

    `runner_vars` is the runner's Go-template vocabulary in PromptContext order
    — served so the prompt-var palette renders what the SERVER knows rather
    than a frontend literal that drifts silently when the runner gains a field.
    """

    runner_vars: list[str]


class LoopTemplateCatalogRead(BaseModel):
    templates: list[LoopTemplateRead]
    meta: LoopTemplateCatalogMeta


class LoopBindingRead(BaseModel):
    """The authoring state behind a bound board's rendered prompts.

    Deliberately NOT `extra="forbid"`: later cards widen this payload (new
    required slots after a template bump, whether a diff is available), and a
    closed model would turn each addition into a coordinated schema change.

    `drift` repeats `template.drift`'s verdict with both versions spelled out,
    because this endpoint is what the bind UI polls to decide whether to offer
    an Update flow — it should not have to infer `bound_version` from a ref it
    also has to parse.
    """

    template: dict
    # Typed for the same reason the preview request is: a `list` slot's stored
    # value is an array, and a reader that assumed `str` would flatten it.
    slot_values: dict[str, str | list[str]]
    rendered_at: str
    rendered_hash: str | None = None
    drift: dict
    diff_available: bool = False


class LoopBindingDiffRead(BaseModel):
    """What changed between the version a board rendered and the current one.

    Computed on demand and never stored: the bound version's content is
    already reconstructible from its snapshot, so caching this would only add
    a way for it to go stale against the template it describes.

    An unchanged kernel is the empty string rather than a header-only diff, so
    the UI can branch on falsiness instead of parsing unified-diff text.
    """

    system_prompt: str
    loop_prompt: str
    slots_delta: dict


class LoopTemplateFitCheck(BaseModel):
    """One setup-contract requirement, judged against this board.

    `status` separates "the operator must act" from "worth knowing":
    `missing` is reserved for requirements a fix can repair, so the UI's
    one-click affordance and the severity never disagree. `fix_id` is the
    handle p2-02's apply endpoint takes, and encodes its own argument
    (`create_column:done`) so applying needs no second lookup.
    """

    id: str
    requirement: str
    status: Literal["ok", "missing", "warn"]
    evidence: str
    fix_id: str | None = None


class LoopTemplateFitRead(BaseModel):
    """What a board HAS vs what a template NEEDS, plus pre-filled slots.

    Open like `LoopBindingRead`: the bind step grows (p2-02 adds applied-fix
    results, p3 adds UI hints) and a closed model would make each addition a
    coordinated schema change.
    """

    template: dict
    checks: list[LoopTemplateFitCheck]
    autofill: dict
    board_frozen: bool
    # None when the board has no completion_query to compare against — a
    # distinct answer from False, which means the two genuinely disagree.
    completion_query_matches_run_label: bool | None = None


class LoopTemplateFitApplyRequest(BaseModel):
    """Which advertised fixes to run. Ids come verbatim from a fit report's
    `fix_id`, so the client never composes one itself."""

    fix_ids: list[str] = []


class LoopTemplateFitApplyResult(BaseModel):
    """What one fix did. `skipped_already_satisfied` is a SUCCESS — it is the
    answer a retry, a double-click, and a stale report all deserve — while
    `rejected` means the fix could not run and says why in `detail`."""

    fix_id: str
    outcome: Literal["applied", "skipped_already_satisfied", "rejected"]
    detail: str


class LoopTemplateFitApplyRead(LoopTemplateFitRead):
    """The refreshed report plus a per-fix ledger.

    Extends the read model rather than wrapping it: the UI redraws the same
    checklist component from either response, and a different shape here would
    make applying a fix a second rendering path.
    """

    applied: list[LoopTemplateFitApplyResult]


class LoopTransitionRead(BaseModel):
    """One enable/disable on the board's loop timeline.

    `source` is the attribution the UI renders and is derived server-side from
    which credential made the call — "runner" when an agent API key did it,
    "human" otherwise — so the frontend never has to infer intent from a
    reason string.
    """

    id: str
    enabled: bool
    reason: str | None
    source: str
    actor_name: str | None
    agent_name: str | None
    iteration_count: int
    occurred_at: str


class LoopTransitionPage(BaseModel):
    """`total` is the unpaged count so the UI can render "showing N of M"
    without walking every page to find out how deep the history goes."""

    transitions: list[LoopTransitionRead]
    total: int


class LoopStatePatch(BaseModel):
    """Runner state transition with an optional, closed stop-reason contract.

    ``reason`` remains required as the exact legacy fallback. New runners may
    additionally send one recognized code with its exact parameter shape. A
    malformed structured reason is rejected so the runner can retry the old
    ``{enabled, reason}`` payload instead of persisting ambiguous metadata.
    """

    model_config = {"extra": "forbid"}

    enabled: bool
    reason: str
    reason_code: LoopDisabledReasonCode | None = None
    reason_params: dict[str, object] | None = None
    diagnostic: str | None = None

    @model_validator(mode="after")
    def validate_structured_reason(self):
        has_structured_metadata = any(
            value is not None
            for value in (self.reason_code, self.reason_params, self.diagnostic)
        )
        if self.enabled:
            if has_structured_metadata:
                raise ValueError("enabled=true cannot include stop-reason metadata")
            return self

        if self.reason_code is None:
            if self.reason_params is not None or self.diagnostic is not None:
                raise ValueError("reason_params and diagnostic require reason_code")
            return self

        if self.reason_params is None:
            raise ValueError("reason_code requires reason_params")

        _validate_known_reason_params(self.reason_code, self.reason_params)
        expected_legacy_reason = _legacy_reason_for_known_code(
            self.reason_code, self.reason_params
        )
        if self.reason != expected_legacy_reason:
            raise ValueError(
                "reason must match the canonical legacy fallback for reason_code"
            )

        return self
