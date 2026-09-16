# Pipeline Role Redesign — 2026-05-16

## Goals

Replace the legacy 3-role (`orchestrator` / `reviewer` / `documentator`) `DEFAULT_PIPELINE_CONFIG` with a 5-role default (`planner` / `implementer` / `reviewer` / `documentator` / `rework_mediator`) that (a) eliminates the FOLLOWUP-13 reviewer-rejection-loop defect by making every decision branch terminate with a card-moving terminal kind, (b) eliminates the FOLLOWUP-14 skip-filter regression by promoting `pipeline_role` to the discriminator field that role-aware filters consult, (c) demonstrates that arbitrary user-authored roles — including rework mediation — compose entirely out of the closed 18-kind lifecycle DSL without any runner-side hardcoded role awareness, (d) drops emission of dead `on_success` / `on_failure` blocks from new configs while keeping schema-level back-compat for legacy persisted configs, and (e) closes the role-name vs LLM-stage-name silos surfaced in the audit (the current `orchestrator` role's LLM stage is `implement` — the new design names the role for the work it does). The lifecycle DSL is the single source of truth for every transition; the Go runner remains role-agnostic.

## Constraint summary

1. **Scope** — full role redesign, not a bug-fix patch.
2. **F-13 fix** — config-only. Add explicit `move_card` step on `request_changes` lifecycle branch and a validator warning when a decision branch lacks a terminal card-moving kind.
3. **F-14 fix** — backend-side. `claim` writes `pipeline_role` = the stage's role name; `skip_if_participant_role` / `require_participant_role` read `pipeline_role`.
4. **Participant taxonomy** — full redesign with migration. New `pipeline_role` field on `Card.participants`. Old `participant_role` (`hero`/`helper`) becomes a free-form display hint; the DSL/lifecycle reads `pipeline_role`.
5. **Role split** — 5 roles: planner + implementer + reviewer + documentator + rework_mediator. `rework_mediator` is a VANILLA role — nothing in the Go runner or backend handlers may know the literal string "rework_mediator". It must be expressible purely as a different `pipeline_config` entry using only generic primitives (discover filters, lifecycle kinds, `wake_role`). If a primitive is missing, flag as follow-up — do not propose runner-side hardcoding.
6. **Legacy blocks** — stop emitting `on_success` / `on_failure` in `DEFAULT_PIPELINE_CONFIG`. Schema keeps the fields (back-compat reads of old persisted v2 configs). Add explicit DEPRECATED comments.

## Closed-set kind inventory (reference)

The palette this design composes from. Every entry below is in `intern/internal/lifecycle/kinds.go` and `backend/app/services/agents/lifecycle_kinds.py`. **No new kinds are introduced by this design.**

| Kind                | ProducesDecision | Terminal | One-line description                                                                              |
|---------------------|------------------|----------|---------------------------------------------------------------------------------------------------|
| `discover`          | false            | false    | Asks the backend scheduler for the next eligible card for this stage (filters, preconditions).    |
| `claim`             | false            | false    | Reserves the card to this runner; writes `pipeline_role` + `execution_action` on the participant. |
| `git_setup`         | false            | false    | Creates a branch (and optionally a PR-tracking row) or checks out an existing PR branch.          |
| `llm`               | **true**         | false    | Invokes the per-stage LLM; may emit a decision string (e.g. `approve` / `request_changes`).        |
| `sensor`            | **true**         | false    | Backend-driven check; may emit a decision string (e.g. `pass` / `fail`).                           |
| `move_card`         | false            | **true** | Moves the card to a column resolved by `to_column_type` or `to_column_id`.                         |
| `apply_label`       | false            | **true** | Adds a label to the card.                                                                          |
| `remove_label`      | false            | **true** | Removes a label from the card.                                                                    |
| `create_note`       | false            | **true** | Writes a note (typically from LLM output) on the card.                                            |
| `enqueue_for_merge` | false            | **true** | Pushes the PR onto the workspace merge queue.                                                     |
| `mcp_call`          | false            | false    | Generic MCP tool invocation (e.g. `remove_card_participant`, `update_card`).                       |
| `branch`            | **true**         | false    | Pure conditional fork in the DSL — no side effect, just routes on a precomputed key.              |
| `wake_role`         | false            | false    | Signals the scheduler to prioritise the named roles on their next tick.                            |
| `create_pr`         | false            | false    | Opens a GitHub PR from the current branch.                                                         |
| `enable_auto_merge` | false            | false    | Arms GitHub auto-merge on the current PR.                                                          |
| `merge_pr`          | false            | false    | Forces a merge of the current PR.                                                                  |
| `post_pr_review`    | false            | false    | Posts a PR review on GitHub with an explicit `decision`.                                          |
| `ship`              | false            | **true** | Convenience terminal: moves card to `to_column_type` AND signals "this hero's pass is done".      |

**Terminal kinds the walker treats as clean stops:** `move_card`, `apply_label`, `remove_label`, `create_note`, `enqueue_for_merge`, `ship`. **Decision-producing kinds:** `llm`, `sensor`, `branch`.

## Participant-taxonomy migration

### Schema sketch

Current `Card.participants` carries (`card_id`, `user_id`, `participant_role`, `execution_action`). The `participant_role` is a string from the frozen set `{hero, helper}`.

Proposed addition (DDL pseudocode):

```sql
ALTER TABLE card_participants
  ADD COLUMN pipeline_role VARCHAR(64) NULL;

CREATE INDEX ix_card_participants_card_pipeline_role
  ON card_participants (card_id, pipeline_role);
```

Semantics:

- `pipeline_role` = the **stage role name** that claimed the card (`planner`, `implementer`, `reviewer`, `documentator`, `rework_mediator`, plus any user-defined role).
- `participant_role` (`hero` / `helper`) is **demoted to a display hint** — the UI may still render "Hero: alice" / "Helper: bob" badges. It carries no DSL semantics.
- `execution_action` stays as the per-claim verb (`implement_card`, `review_card`, etc.) — useful for activity logs but no longer the canonical role discriminator.

### Three-phase migration

**Phase 1 — Add nullable column (single deploy).**
Alembic migration adds `pipeline_role VARCHAR(64) NULL`. Backend reads tolerate both `pipeline_role IS NULL` (legacy) and `pipeline_role = '<role>'` (new). New claims via the lifecycle `claim` kind write `pipeline_role = stage.role`. Existing rows stay `NULL`. Filters that consult `pipeline_role` short-circuit to "no match" on NULL — i.e. legacy unmigrated cards are never skipped, preserving today's behaviour.

**Phase 2 — Backfill (data migration, run once after Phase 1 deploy).**
SQL backfill maps `execution_action` → `pipeline_role`:

```
'implement_card'  → 'implementer'
'review_card'     → 'reviewer'
'document_card'   → 'documentator'
```

Backfill is idempotent (`UPDATE ... WHERE pipeline_role IS NULL`). Any unmapped `execution_action` (custom roles authored after Phase 1) stays NULL and is filled by Phase 3.

**Phase 3 — Enforce non-null at the claim site (Go runner + backend).**
The lifecycle `claim` handler refuses to commit without a non-empty `pipeline_role` (validator-side: see Validation rules §2). Once Phase 2 is complete in prod, an Alembic migration adds `ALTER TABLE card_participants ALTER COLUMN pipeline_role SET NOT NULL`. The legacy `participant_role` column stays as-is (now display-only).

### Filter semantics change

The two role-aware discover filters defined in `pipeline_config_validation.py` semantics today key on `participant_role`. After Phase 1:

- `filters.skip_if_participant_role: <role>` — short-hand kept for back-compat. Now reads `pipeline_role`. (Renamed to `skip_if_pipeline_role` over a deprecation window if we want to tighten naming; **DECISION NEEDED**, see Open questions.)
- `filters.require_participant_role: <role>` — same semantics flip.

For the duration of the deprecation window the backend interprets both names. A canonicaliser pass in `canonicalize_pipeline_config` rewrites the old name to the new one in persisted snapshots so the UI/editor only deals with one name.

### Effect on FOLLOWUP-14

Today's reviewer filter `skip_if_participant_role: "reviewer"` never matches because `claim` writes `helper`. After migration, the reviewer's `claim` step writes `pipeline_role: "reviewer"` and the filter matches. The rejection-loop scenario then degrades to "card stays in `active` with no participant" — which is the intended outcome of `request_changes` post-FOLLOWUP-13 fix.

---

## Role designs

Every role below carries: discover, claim, git, llm, full lifecycle DSL, default-prompt skeleton, discover-filter rationale, smoke pass/fail.

### Role: `planner`

- **discover**:
  - `column_type`: `backlog`
  - `filters`: `require_git_repo: true`, `skip_if_pipeline_role: planner`, `exclude_label: planned`, `exclude_label: do-not-plan`
  - `preconditions`: none (planning never blocks on PR state)
- **claim**: `pipeline_role: planner`, `execution_action: plan_card`
- **git**: `action: none` (planning produces a plan note, not code)
- **llm**:
  - `stage: plan`
  - `prompt slug: planner` (looked up via `AgentPromptConfig`)
  - `tools`: `mcp__valaris__get_card`, `mcp__valaris__get_project_context`, `mcp__valaris__decompose_card`, `mcp__valaris__create_note`, `mcp__valaris__log_execution_update`
  - `inject_directives: true`
  - `approval_enabled: false`
  - `post_process_kind: produces_note`
- **lifecycle**:
  ```yaml
  - name: discover_backlog
    kind: discover
    params:
      strategy: column_scan
      column_type: backlog
      filters:
        require_git_repo: true
        skip_if_pipeline_role: planner
        exclude_label: planned
        exclude_label: do-not-plan
    next: claim_for_planning
  - name: claim_for_planning
    kind: claim
    params:
      pipeline_role: planner
      execution_action: plan_card
      participant_role: helper      # display hint only
    next: produce_plan_note
  - name: produce_plan_note
    kind: llm
    params:
      stage: plan
      provider: claude-cli
      model: sonnet                 # see DECISION NEEDED — default model per role
      post_process_kind: produces_note
      tools: [...]
      inject_directives: true
      approval_enabled: false
    next: write_plan_note
    on_failure: planner_fail_unassign
  - name: write_plan_note
    kind: create_note
    params:
      from_llm_output: true
      kind: plan                    # see DECISION NEEDED — note kind for plan
    # create_note is terminal.
  # Failure subtree:
  - name: planner_fail_unassign
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: planner_fail_label
  - name: planner_fail_label
    kind: apply_label
    params: { label: planning-failed }
  ```
  > Note: the `planned` label is intentionally NOT set inside the lifecycle DSL — promoting the card to `active` (and thereby making it visible to `implementer`) is the operator's signal that the plan is acceptable. **DECISION NEEDED** if we want the planner to auto-promote (`apply_label: planned` + `move_card to_column_type: active`) instead.
- **Default prompt template skeleton** (the implementer-of-the-prompt fills the bracketed sections):
  ```
  You are the planner role for the Valaris kanban card.
  Inputs: card title, description, board definition, project directives.
  Task:
    1. Read the card and project context.
    2. [Produce a 3-7 step implementation plan, calling decompose_card if the card is large.]
    3. [Identify the seams the implementer must respect — files, modules, tests.]
    4. Write a single plan note via create_note (the lifecycle handles this — your job is to emit the body in the closing block).
  Constraints:
    - Do not write code.
    - Do not modify the card title/description without explicit user instruction.
    - [Domain-specific rules go here.]
  ```
- **Discover filter rationale**: Picks cards from `backlog` only. `skip_if_pipeline_role: planner` keeps the planner from re-planning a card it already planned (one plan per card per session). `exclude_label: planned` prevents re-pickup of cards an operator has already promoted. `exclude_label: do-not-plan` is the operator escape hatch for trivial cards.
- **Pass/fail criteria for smoke**:
  - PASS: a fresh backlog card acquires exactly one `plan` note, the `planner` participant is recorded, no label is added.
  - FAIL: more than one plan note appears (planner re-claimed the same card), or the card is moved out of `backlog` (planner shouldn't move).

### Role: `implementer`

- **discover**:
  - `column_type`: `active`
  - `filters`: `require_git_repo: true`, `skip_if_pipeline_role: implementer`
  - `preconditions`: `repo_has_no_open_pr` (one PR at a time per repo unless parallel mode is on)
- **claim**: `pipeline_role: implementer`, `execution_action: implement_card`
- **git**: `action: create_branch`, `branch_prefix: ""`, `base_ref: integration_branch`, `create_pr: true`, `force_push_on_rework: true`
- **llm**:
  - `stage: implement`
  - `prompt slug: implementer`
  - `tools`: `mcp__valaris__get_card`, `mcp__valaris__get_project_context`, `mcp__valaris__log_execution_update`, `mcp__valaris__request_approval`
  - `inject_directives: true`
  - `approval_enabled: true`
  - `post_process_kind: writes_code`
  - `context_sources`: `[{kind: card_notes, filter: {kind: plan}, as: plan}, {kind: review_history}]`
- **lifecycle**:
  ```yaml
  - name: discover_active
    kind: discover
    params:
      strategy: unassigned_or_rework
      column_type: active
      filters:
        require_git_repo: true
        skip_if_pipeline_role: implementer
      preconditions: [repo_has_no_open_pr]
    next: claim_for_implementation
  - name: claim_for_implementation
    kind: claim
    params:
      pipeline_role: implementer
      execution_action: implement_card
      participant_role: hero        # display hint only
    next: setup_feature_branch
  - name: setup_feature_branch
    kind: git_setup
    params:
      action: create_branch
      branch_prefix: ""
      create_pr: true
      force_push_on_rework: true
      base_ref: integration_branch
    next: implement_code
  - name: implement_code
    kind: llm
    params:
      stage: implement
      provider: claude-cli
      model: sonnet
      post_process_kind: writes_code
      tools: [...]
      inject_directives: true
      approval_enabled: true
      context_sources:
        - { kind: card_notes, filter: { kind: plan }, as: plan }
        - { kind: review_history }
    next: open_pr
    on_failure: implementer_fail_unassign
  - name: open_pr
    kind: create_pr
    params: {}
    next: arm_auto_merge
    on_failure: implementer_fail_unassign
  - name: arm_auto_merge
    kind: enable_auto_merge
    params: {}
    next: wake_reviewer
    on_failure: implementer_fail_unassign  # soft-fail wake still happens
  - name: wake_reviewer
    kind: wake_role
    params: { roles: [reviewer] }
    next: ship_to_review
  - name: ship_to_review
    kind: ship
    params: { to_column_type: review }
  # Failure subtree:
  - name: implementer_fail_unassign
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: implementer_fail_move_back
  - name: implementer_fail_move_back
    kind: move_card
    params: { to_column_type: backlog }
  ```
- **Default prompt template skeleton**:
  ```
  You are the implementer role for the Valaris kanban card.
  Inputs: card title, description, plan note (from the planner), review history (if any), project directives.
  Task:
    1. Read the plan note. If absent, [fall back to a minimal plan in-head].
    2. Implement the card per the plan. Follow project directives strictly.
    3. Run the relevant tests. [List the test commands per stack here.]
    4. Commit and push. The lifecycle opens the PR.
  Constraints:
    - TDD is mandatory: write failing test, then code, then refactor.
    - Do not skip layers (Router -> Service -> Repository -> Model on the backend).
    - [Domain-specific rules go here.]
  ```
- **Discover filter rationale**: Picks `active` column cards. `skip_if_pipeline_role: implementer` prevents the implementer from re-claiming a card it just shipped (idempotence under runner re-issue). `repo_has_no_open_pr` keeps two implementers from forking off the same base into separate PRs (legacy starvation fix from card 9bb8ba47).
- **Pass/fail criteria for smoke**:
  - PASS: card has a PR URL, branch pushed, card moves to `review`, `implementer` participant recorded.
  - FAIL: card stuck in `active` with no PR, or PR opened but card not moved.

### Role: `reviewer`

- **discover**:
  - `column_type`: `review`
  - `filters`: `require_pr_url: true`, `require_git_repo: true`, `skip_if_pipeline_role: reviewer`
  - `preconditions`: none
- **claim**: `pipeline_role: reviewer`, `execution_action: review_card`
- **git**: `action: checkout_pr_branch`, `create_pr: false`, `force_push_on_rework: false`
- **llm**:
  - `stage: review`
  - `prompt slug: reviewer`
  - `tools`: `mcp__valaris__get_card`, `mcp__valaris__get_project_context`
  - `inject_directives: true` (parity with implementer — see `project_reviewer_inject_directives_asymmetry.md`)
  - `approval_enabled: false`
  - `post_process_kind: produces_decision`
  - `context_sources`: `[{kind: card_notes, filter: {kind: plan}, as: plan}, {kind: review_history}]`
- **lifecycle** (the FOLLOWUP-13 fix is in the `request_changes` branch — every branch terminates with a card-moving kind):
  ```yaml
  - name: discover_review_column
    kind: discover
    params:
      strategy: column_scan
      column_type: review
      filters:
        require_pr_url: true
        skip_if_pipeline_role: reviewer
        require_git_repo: true
    next: claim_for_review
  - name: claim_for_review
    kind: claim
    params:
      pipeline_role: reviewer
      execution_action: review_card
      participant_role: helper
    next: checkout_pr_branch
  - name: checkout_pr_branch
    kind: git_setup
    params:
      action: checkout_pr_branch
      create_pr: false
      force_push_on_rework: false
    next: review_diff
  - name: review_diff
    kind: llm
    params:
      stage: review
      provider: claude-cli
      model: sonnet                 # see DECISION NEEDED — opus for reviewer?
      post_process_kind: produces_decision
      tools: [...]
      inject_directives: true
      approval_enabled: false
      context_sources:
        - { kind: card_notes, filter: { kind: plan }, as: plan }
        - { kind: review_history }
    branches:
      approve: post_pr_review_approve
      request_changes: post_pr_review_request_changes
  # approve branch
  - name: post_pr_review_approve
    kind: post_pr_review
    params: { decision: approve }
    next: merge_the_pr
  - name: merge_the_pr
    kind: merge_pr
    params: {}
    next: write_approve_note
    on_failure: approve_merge_fail_note
  - name: write_approve_note
    kind: create_note
    params:
      from_llm_output: true
      kind: review_verdict
    # NB: create_note is terminal. The next step (wake_documentator,
    # approve_move_done) lives in a sibling branch chain instead — see below.
  # The above approve subtree TERMINATES at write_approve_note. We need the
  # wake + move on the same path. Restructure: invert the order so move/wake
  # come BEFORE the note. The note is the last terminal, after the card moves.
  ```
  Corrected approve branch (the note is the terminal, but it lives AFTER the move/wake):
  ```yaml
  # approve branch (corrected for terminal-kind ordering)
  - name: post_pr_review_approve
    kind: post_pr_review
    params: { decision: approve }
    next: merge_the_pr
  - name: merge_the_pr
    kind: merge_pr
    params: {}
    next: approve_move_done
    on_failure: approve_merge_fail_note
  - name: approve_move_done
    kind: move_card
    params: { to_column_type: done }
    # move_card is terminal — but we need wake + note AFTER moving.
    # Cannot continue past a terminal. Solution: do wake + note BEFORE move.
  ```
  Final correct approve branch — order is `post_pr_review -> merge_pr -> wake_documentator -> write_approve_note (terminal create_note)` and we use `move_card` as the terminal instead, with `wake_role` before it. Since `wake_role` is non-terminal and `create_note` is terminal, only one terminal per chain — pick `move_card`:
  ```yaml
  - name: post_pr_review_approve
    kind: post_pr_review
    params: { decision: approve }
    next: merge_the_pr
  - name: merge_the_pr
    kind: merge_pr
    params: {}
    next: write_approve_note
    on_failure: approve_merge_fail_note
  - name: write_approve_note
    kind: mcp_call            # NOT create_note kind — mcp_call create_note is non-terminal
    params:
      tool: create_note
      args:
        kind: review_verdict
        body: "$llm_output"
    next: wake_documentator
  - name: wake_documentator
    kind: wake_role
    params: { roles: [documentator] }
    next: approve_move_done
  - name: approve_move_done
    kind: move_card
    params: { to_column_type: done }
  # request_changes branch (FOLLOWUP-13 fix — terminates with move_card)
  - name: post_pr_review_request_changes
    kind: post_pr_review
    params: { decision: request_changes }
    next: request_changes_unassign_self
  - name: request_changes_unassign_self
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: request_changes_write_verdict
  - name: request_changes_write_verdict
    kind: mcp_call            # NOT create_note kind — keep chain open
    params:
      tool: create_note
      args:
        kind: review_verdict
        body: "$llm_output"
        failure_class: needs_rework
    next: wake_rework_mediator
  - name: wake_rework_mediator
    kind: wake_role
    params: { roles: [rework_mediator] }
    next: request_changes_move_back
  - name: request_changes_move_back
    kind: move_card
    params: { to_column_type: active }
  # Merge-failure side-tree (approve branch's on_failure)
  - name: approve_merge_fail_note
    kind: mcp_call
    params:
      tool: create_note
      args:
        kind: review_verdict
        body: "merge failed — operator must triage"
        failure_class: merge_failed
    next: approve_merge_fail_label
  - name: approve_merge_fail_label
    kind: apply_label
    params: { label: merge-failed }
  ```
  > **Design note on terminal ordering:** the kind `create_note` is terminal in the walker. To express "write a note AND continue" we use `mcp_call` with `tool: create_note` (non-terminal). The terminal-kind `create_note` is reserved for "final say + stop". This is a pre-existing pattern in the legacy default for `request_changes_create_note` and is acceptable; no new primitive needed.

- **Default prompt template skeleton**:
  ```
  You are the reviewer role for the Valaris kanban card.
  Inputs: card title, description, plan note, prior review history, the PR diff (you have checked it out).
  Task:
    1. Read the plan and the diff.
    2. Verify the diff implements the plan and respects project directives.
    3. Run [the test commands per stack here] to confirm CI is green.
    4. Emit a verdict decision: `approve` or `request_changes`.
    5. In your closing block, write the verdict body (findings + a failure_class for `request_changes`).
  Constraints:
    - Reject if any directive is violated, even cosmetically.
    - Reject if tests don't run / fail.
    - [Domain-specific rules here.]
  ```
- **Discover filter rationale**: Picks `review` column cards. `require_pr_url` because there is nothing to review without a PR. `skip_if_pipeline_role: reviewer` (post-FOLLOWUP-14 fix) means the same reviewer doesn't re-review its own approved card. Multiple distinct reviewer agents (different `user_id`) can still review the same card sequentially because the filter is keyed on role, not user.
- **Pass/fail criteria for smoke**:
  - PASS-approve: card moves to `done`, PR is merged, `review_verdict` note exists, `documentator` is woken.
  - PASS-request_changes: card moves to `active`, reviewer is unassigned, `review_verdict` note with `failure_class: needs_rework` exists, `rework_mediator` is woken.
  - FAIL: card stays in `review` with no participant (the FOLLOWUP-13 + FOLLOWUP-14 loop pattern).

### Role: `rework_mediator`

> CRITICAL: vanilla role. Nothing in the Go runner or backend handlers may reference the literal `"rework_mediator"`. Built entirely from generic primitives.

- **discover**:
  - `column_type`: `active`
  - `filters`: `require_git_repo: true`, `skip_if_pipeline_role: rework_mediator`, `require_pr_url: true`, `require_note_kind: review_verdict`, `require_note_failure_class: needs_rework`
  - `preconditions`: none
- **claim**: `pipeline_role: rework_mediator`, `execution_action: mediate_rework`
- **git**: `action: checkout_pr_branch` (mediator reads the existing PR branch; does not fork a new one)
- **llm**:
  - `stage: mediate_rework`
  - `prompt slug: rework_mediator`
  - `tools`: `mcp__valaris__get_card`, `mcp__valaris__get_project_context`, `mcp__valaris__create_note`, `mcp__valaris__log_execution_update`
  - `inject_directives: true`
  - `approval_enabled: false`
  - `post_process_kind: produces_note`
  - `context_sources`: `[{kind: card_notes, filter: {kind: plan}, as: plan}, {kind: card_notes, filter: {kind: review_verdict}, as: review_verdicts}, {kind: review_history}]`
- **lifecycle**:
  ```yaml
  - name: discover_rework_candidates
    kind: discover
    params:
      strategy: column_scan
      column_type: active
      filters:
        require_git_repo: true
        require_pr_url: true
        require_note_kind: review_verdict
        require_note_failure_class: needs_rework
        skip_if_pipeline_role: rework_mediator
    next: claim_for_mediation
  - name: claim_for_mediation
    kind: claim
    params:
      pipeline_role: rework_mediator
      execution_action: mediate_rework
      participant_role: helper
    next: checkout_existing_branch
  - name: checkout_existing_branch
    kind: git_setup
    params:
      action: checkout_pr_branch
      create_pr: false
      force_push_on_rework: false
    next: produce_rework_brief
  - name: produce_rework_brief
    kind: llm
    params:
      stage: mediate_rework
      provider: claude-cli
      model: sonnet                 # DECISION NEEDED — possibly opus
      post_process_kind: produces_note
      tools: [...]
      inject_directives: true
      approval_enabled: false
      context_sources:
        - { kind: card_notes, filter: { kind: plan }, as: plan }
        - { kind: card_notes, filter: { kind: review_verdict }, as: review_verdicts }
        - { kind: review_history }
    next: write_rework_brief
    on_failure: rework_fail_unassign
  - name: write_rework_brief
    kind: mcp_call           # non-terminal create_note via mcp_call (see reviewer note)
    params:
      tool: create_note
      args:
        kind: rework_brief
        body: "$llm_output"
    next: wake_implementer
  - name: wake_implementer
    kind: wake_role
    params: { roles: [implementer] }
    next: mediator_unassign_self
  - name: mediator_unassign_self
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: mediator_done_label
  - name: mediator_done_label
    kind: apply_label
    params: { label: rework-brief-ready }
  # Failure subtree:
  - name: rework_fail_unassign
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: rework_fail_label
  - name: rework_fail_label
    kind: apply_label
    params: { label: rework-mediation-failed }
  ```
  > Note on labels: `rework-brief-ready` and `rework-mediation-failed` are operator-visible breadcrumbs. The implementer's discover filter is `skip_if_pipeline_role: implementer` and does NOT key on these labels — the implementer just notices its plan-note context now contains a `rework_brief` and proceeds. The mediator unassigns BEFORE applying the label so the lifecycle terminates cleanly on the label step.
- **Default prompt template skeleton**:
  ```
  You are the rework_mediator role. The reviewer rejected this card and emitted a verdict.
  Inputs: original plan note, review_verdict notes, review_history, PR diff (you have checked it out).
  Task:
    1. Read the latest review_verdict (newest first).
    2. Distill the reviewer's findings into a focused rework brief: what must change, in which files, with which tests.
    3. Do NOT propose code. Your output is a directive for the next implementer pass.
    4. Emit the brief body in your closing block; the lifecycle writes it as a `rework_brief` note.
  Constraints:
    - The implementer reads this brief instead of re-reading the full plan from scratch.
    - Be specific: file paths, function names, test commands.
  ```
- **Discover filter rationale**: Picks `active` column cards that (a) have a PR, (b) carry at least one `review_verdict` note with `failure_class: needs_rework`, (c) have not already been mediated by this role. The presence of `require_note_kind` + `require_note_failure_class` is what distinguishes "fresh card" (no review_verdict) from "rework card" (has a needs_rework verdict). The implementer's filter does NOT need to be modified to ignore rework cards because the rework brief is just an extra context source — the implementer is rework-agnostic.

- **Pass/fail criteria for smoke**:
  - PASS: a `rework_brief` note appears on the card, the mediator unassigns itself, the implementer wakes and picks the card up.
  - FAIL: mediator loops on the same card (would mean `skip_if_pipeline_role` is broken), or mediator picks up a fresh non-rework card (would mean the note-filter is broken).

#### Generic-primitives audit (REQUIRED for rework_mediator)

| Primitive used | Closed-set kind / known filter? | Notes |
|---|---|---|
| `discover` kind | YES (in `kinds.go`) | No new kind. |
| `discover.filters.require_git_repo` | YES (existing) | — |
| `discover.filters.require_pr_url` | YES (existing) | — |
| `discover.filters.skip_if_pipeline_role` | **NEW PRIMITIVE NEEDED — filter rename** | Current code path is `skip_if_participant_role`. Rename is part of the F-14 fix; semantic content identical (now reads `pipeline_role`). |
| `discover.filters.require_note_kind: review_verdict` | **NEW PRIMITIVE NEEDED** | No existing filter selects cards by presence of a note of a given kind. The scheduler today filters on column/label/participant/PR-url only. This must be added to the backend scheduler's filter evaluator and to `pipeline_config_validation.py`'s discover-filter schema. **No new lifecycle kind required** — this is a filter on the existing `discover` kind. |
| `discover.filters.require_note_failure_class: needs_rework` | **NEW PRIMITIVE NEEDED** | Same: filter on note attribute. Composable with `require_note_kind` (AND semantics). |
| `claim` kind with `pipeline_role` param | YES (kind exists); param NEW under F-14 fix | Phase-1 schema change. |
| `git_setup` kind, action `checkout_pr_branch` | YES (existing) | — |
| `llm` kind | YES (existing) | — |
| `llm.context_sources` with `card_notes` filter `kind: review_verdict` | YES (existing) | `_CONTEXT_SOURCE_KINDS` already includes `card_notes` and the filter validator accepts `{kind: <note_kind>}` — see `_validate_context_source_filter`. The note kind `review_verdict` is new but the context-source machinery already supports arbitrary note kinds from `app.models.notes.kinds`. **`review_verdict` and `rework_brief` and `plan` note kinds must be registered in `app.models.notes.kinds`** — minor data-model addition, not a new primitive. |
| `mcp_call` kind (for non-terminal `create_note` and `remove_card_participant`) | YES (existing) | — |
| `wake_role` kind | YES (existing) | — |
| `apply_label` kind | YES (existing, terminal) | — |

**Summary of NEW PRIMITIVE NEEDED items** (filed as follow-ups; **rework_mediator works in DEGRADED MODE without them — see below**):

1. **`discover.filters.skip_if_pipeline_role`** — rename of `skip_if_participant_role`. Easy lift. Filed as part of F-14 fix work.
2. **`discover.filters.require_note_kind`** — new scheduler filter. Without it, rework_mediator cannot discriminate rework cards from fresh cards by note presence.
3. **`discover.filters.require_note_failure_class`** — new scheduler filter. Without it, rework_mediator cannot discriminate "needs rework" verdicts from "approve" verdicts (both are kind `review_verdict`).

**Degraded mode (if 2+3 land later):** the rework_mediator falls back to a label-based discriminator that the reviewer already emits — `apply_label: needs-rework` on the `request_changes` branch — combined with `exclude_label: rework-brief-ready` to avoid re-mediation. The reviewer's lifecycle gets an extra `apply_label` step before the terminal `move_card`. This works today with zero new primitives but conflates "needs rework" with "labelled needs rework" and pollutes the card label set. The note-attribute filters are strictly preferable; the label fallback is the bridge.

The user has explicitly said: **do NOT propose runner-side hardcoding**. None of the three items above touch runner code — they are backend-scheduler filter additions (Python) and a config-validation rename. The Go walker remains entirely generic.

### Role: `documentator`

- **discover**:
  - `column_type`: `done`
  - `filters`: `exclude_label: documented`, `exclude_label: documentation-failed`, `require_git_repo: true`, `skip_if_pipeline_role: documentator`
  - `preconditions`: none
- **claim**: `pipeline_role: documentator`, `execution_action: document_card`
- **git**: `action: create_branch`, `branch_prefix: docs-`, `base_ref: integration_branch`, `create_pr: false`, `force_push_on_rework: false`
- **llm**:
  - `stage: document`
  - `prompt slug: documentator`
  - `tools`: `mcp__valaris__create_note`, `mcp__valaris__get_card`, `mcp__valaris__get_project_context`, `mcp__valaris__list_notes`, `mcp__valaris__log_execution_update`
  - `inject_directives: true` (flipped from legacy `false` — directives should govern docs too; **DECISION NEEDED** if we want a per-role override)
  - `approval_enabled: false`
  - `post_process_kind: writes_code`
- **lifecycle**:
  ```yaml
  - name: discover_done_column
    kind: discover
    params:
      strategy: column_scan
      column_type: done
      filters:
        exclude_label: documented
        exclude_label: documentation-failed
        require_git_repo: true
        skip_if_pipeline_role: documentator
    next: claim_for_docs
  - name: claim_for_docs
    kind: claim
    params:
      pipeline_role: documentator
      execution_action: document_card
      participant_role: helper
    next: setup_docs_branch
  - name: setup_docs_branch
    kind: git_setup
    params:
      action: create_branch
      branch_prefix: docs-
      create_pr: false
      force_push_on_rework: false
      base_ref: integration_branch
    next: generate_docs
  - name: generate_docs
    kind: llm
    params:
      stage: document
      provider: claude-cli
      model: sonnet
      post_process_kind: writes_code
      tools: [...]
      inject_directives: true
      approval_enabled: false
    next: doc_unassign_self
    on_failure: docs_fail_unassign
  - name: doc_unassign_self
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: label_documented
  - name: label_documented
    kind: apply_label
    params: { label: documented }
  # Failure subtree:
  - name: docs_fail_unassign
    kind: mcp_call
    params:
      tool: remove_card_participant
      args: { user_id: "$self" }
    next: docs_fail_label
  - name: docs_fail_label
    kind: apply_label
    params: { label: documentation-failed }
  ```
  > Note: added `exclude_label: documentation-failed` to discover filters (audit item: today the failure label is not excluded, so failed cards loop on documentator until a human intervenes — a minor secondary bug flagged in the audit). Also added explicit `mcp_call: remove_card_participant` step in the success path so the documentator releases its slot before the terminal label step.
- **Default prompt template skeleton**:
  ```
  You are the documentator role for the Valaris kanban card.
  Inputs: card title, description, merged PR diff, prior notes.
  Task:
    1. Read what changed.
    2. Update user-facing docs (README, runbook, docstrings) that describe the changed behaviour.
    3. Commit the doc changes on the docs-<card-id> branch. No PR — docs land directly via the docs branch.
  Constraints:
    - Do not modify code in `app/` / `src/`.
    - [Domain-specific rules here.]
  ```
- **Discover filter rationale**: Picks `done` cards that have a git repo, are not already documented, and have not already failed documentation. The `skip_if_pipeline_role: documentator` filter is belt-and-braces (the `documented` label catches the common case; the role filter catches the edge case where the label was removed manually).
- **Pass/fail criteria for smoke**:
  - PASS: card receives `documented` label, docs branch exists with a commit, documentator unassigned.
  - FAIL: card oscillates between documented/un-documented (label race), or `documentation-failed` cards re-claimed (secondary-bug regression).

---

## Validation rules to add

The following rules extend `backend/app/services/pipeline_config_validation.py`. Each new rule has a stable error `code` for UI surfacing.

1. **`lifecycle_decision_branch_missing_terminal_move`** (FOLLOWUP-13 guard). Every decision-producing kind (`llm` with `produces_decision`, `sensor`, `branch`) that declares `branches` MUST have every branch eventually terminate with a card-moving terminal kind. Card-moving terminals are: `move_card`, `ship`. `apply_label` and `create_note` are terminals but do NOT move the card — they raise a **warning** (not error) when used as the final step of a decision branch, unless the branch explicitly opts out via `branches: { <decision>: <stepname>, _allow_in_place: true }`. **DECISION NEEDED** on whether to make the opt-out keyword `_allow_in_place` or just skip the warning for branches that include a `wake_role` step (more permissive). The walker is the single source of truth on what counts as terminal (`Kinds[k].Terminal`); the validator runs a graph traversal from each branch entry to confirm reachability of a card-moving terminal.

2. **`claim_missing_pipeline_role`** (F-14 fix). Every `claim` step's params MUST include a non-empty `pipeline_role` string. The legacy `participant_role: "hero"|"helper"` is still accepted (as a display hint) but is no longer the canonical role discriminator. Configs that set `participant_role` but omit `pipeline_role` get a deprecation warning during Phase 1; the warning becomes an error in Phase 3 (post-backfill).

3. **`git_setup_create_pr_without_explicit_create_pr_kind`**. Every `git_setup` step with `action: create_branch` AND `create_pr: true` MUST be followed somewhere downstream by an explicit `create_pr` kind. Today the legacy Tick path opens the PR implicitly as a side effect of branch creation; the walker requires the side effect to be an explicit step. Existing `DEFAULT_PIPELINE_CONFIG` already has the explicit `create_pr_for_card` step — this rule prevents regression.

4. **`lifecycle_non_terminal_missing_successor`** (already present in `_validate_lifecycle` as `lifecycle_step_missing_next` — keep). Every non-terminal kind MUST declare either `next` or `branches`. The walker `resolveNext` enforces this at runtime; the validator rejects at submit time so operators don't ship broken configs.

5. **`lifecycle_decision_kind_missing_branch_for_known_decision`** (lighter version of rule 1). When the `llm.post_process_kind` is `produces_decision` and the stage name is a known stage (`review`), the validator knows the decision set is `{approve, request_changes}` and warns if a branch is missing for either. For custom stages with unknown decision sets, no warning.

6. **`lifecycle_legacy_block_emitted`** (NEW DEPRECATION WARNING). When a stage carries BOTH a `lifecycle` array AND a non-empty `on_success`/`on_failure` block, emit a deprecation warning that `on_success`/`on_failure` is dead-code under the walker. This is informational — does not block save. `DEFAULT_PIPELINE_CONFIG` post-redesign emits neither block; old persisted configs read fine but get the warning.

7. **`discover_filter_unknown_key`**. The `filters` map today is open — any key passes. Tighten to a closed set: `{require_git_repo, require_pr_url, exclude_label, skip_if_pipeline_role, require_pipeline_role, require_note_kind, require_note_failure_class}` (the last two are NEW PRIMITIVES NEEDED per the rework_mediator audit). Unknown filter keys raise an error; this catches typos like `skip_if_partcipant_role` that silently disable the filter today.

---

## Wake-role chain

```
                       +-----------------+
                       |   discover      |
                       |   backlog       |
                       +--------+--------+
                                |
                                v
                       +-----------------+
                       |     planner     |
                       | (writes plan)   |
                       +--------+--------+
                                |
                                | operator promotes card backlog -> active
                                | (UI / human gate; no auto-promotion)
                                v
                       +-----------------+
                       |   implementer   |--+
                       |  (writes code,  |  |
                       |   opens PR)     |  |
                       +--------+--------+  |
                                |           |
                          wake_role         |
                          [reviewer]        |
                                |           |
                                v           |
                       +-----------------+  |
                       |    reviewer     |  |
                       |  (PR review)    |  |
                       +---+---------+---+  |
                           |         |      |
                  approve  |         | request_changes
                           |         |      |
                  wake_role|         | wake_role
                  [docs]   |         | [rework_mediator]
                           |         |      |
                           v         v      |
                +-------------+   +-----------------+
                | documentator|   | rework_mediator |
                | (writes docs|   | (writes brief)  |
                +-------------+   +--------+--------+
                                           |
                                     wake_role
                                     [implementer]
                                           |
                                           +---> back to implementer
                                                 (loop until reviewer
                                                 approves)
```

**Where each `wake_role` step lives in the DSL:**
- `implementer.lifecycle["wake_reviewer"]` — between `arm_auto_merge` and `ship_to_review`.
- `reviewer.lifecycle["wake_documentator"]` — in the `approve` branch, between `write_approve_note` and `approve_move_done`.
- `reviewer.lifecycle["wake_rework_mediator"]` — in the `request_changes` branch, between `request_changes_write_verdict` and `request_changes_move_back`.
- `rework_mediator.lifecycle["wake_implementer"]` — between `write_rework_brief` and `mediator_unassign_self`.

The planner does NOT wake the implementer. Promotion from `backlog` → `active` is a human operator gate (the audit's recommendation: the planner produces a plan note; the operator reviews and promotes). **DECISION NEEDED** if we want the planner to optionally auto-promote when a `auto-implement` board-level flag is set.

---

## Legacy-block deprecation

- `DEFAULT_PIPELINE_CONFIG` no longer emits `on_success` / `on_failure` on any stage; the lifecycle DSL is the only source of truth.
- The JSON schema (`pipeline_config_validation.py`) keeps `on_success` / `on_failure` as recognised optional fields so existing persisted configs read without 422s.
- `canonicalize_pipeline_config` emits a `DEPRECATED` log warning (visible in backend logs and surfaced via the workspace config GET endpoint as a `warnings: []` field on the response envelope) when it observes a persisted config with non-empty `on_success`/`on_failure` AND a non-empty `lifecycle`.
- Per-workspace migration is **opt-in**: an operator runs an "Export → edit → Import" round-trip via the workspace-config UI to strip the legacy blocks. No automatic in-place migration — the audit found 12/13 workspaces have no persisted row anyway, so they inherit the new default for free.
- Two-deploy plan to remove the schema fields entirely (not in this design's scope): (1) deploy this design; (2) after a quarter of warnings, deploy a follow-up that drops `on_success`/`on_failure` from the schema and rejects them at validation time.

---

## Open questions for user

- **DECISION NEEDED — Filter name rename window.** Keep `skip_if_participant_role` as a back-compat alias forever, or sunset it after one quarter once `skip_if_pipeline_role` is the canonical name?
- **DECISION NEEDED — Default LLM model per role.** The audit recommends Opus for reviewer (catches more); current default is Sonnet for all. Proposal: Sonnet for planner / implementer / documentator, Opus for reviewer + rework_mediator (rejection-distillation needs reasoning). Confirm model assignment.
- **DECISION NEEDED — Planner auto-promotion.** Should the planner automatically move the card from `backlog` → `active` after writing the plan note, or always require human promotion? Proposed default: human gate. If auto-promote, the planner's lifecycle needs an extra `move_card to_column_type: active` step.
- **DECISION NEEDED — `note_kind` for the planner's output.** Proposed: register a new `plan` note kind in `app.models.notes.kinds`. Also register `review_verdict` and `rework_brief`. Confirm naming.
- **DECISION NEEDED — Documentator `inject_directives` default.** Current legacy default is `false`; the audit flags this as a silent gap (e.g. a "all docs need a security section" directive would be ignored). Proposed flip: `true`. Confirm.
- **DECISION NEEDED — `pipeline_role` column rename.** The proposed name is `pipeline_role` (to match the DSL field). Alternative considered: `stage_role`. Confirm `pipeline_role`.
- **DECISION NEEDED — Validator rule #1 warning semantics.** When a decision branch's tail is `apply_label` or `create_note` (terminal but not card-moving), warn or error? Proposal: warn unless the branch contains a `move_card` or `ship` step somewhere — i.e. don't punish branches that intentionally label-only (e.g. documentator success). Confirm.
- **DECISION NEEDED — Pilot-workspace-specific overrides.** The pilot workspace has the only persisted v3 config. After this redesign deploys, do we (a) wipe its persisted row so it inherits the new default, or (b) leave it persisted (legacy 3-role) until the operator opts in? Proposal: wipe with operator consent, since the persisted row is byte-for-byte equal to the legacy default plus a single `cleanup_review_notes` drift.
- **DECISION NEEDED — Prompt template content.** The skeletons above are stubs. Final prompts are a separate deliverable (a dedicated prompt-templates doc, or five Backplane-board cards). Confirm scope split.

---

## Resolved decisions (2026-05-16 session)

User has accepted all 9 proposed defaults from the Open questions section, with one caveat regarding LLM model assignment (see Model-tier abstraction subsection below).

1. **Filter rename window:** Keep `skip_if_participant_role` as a back-compat alias. Sunset target: end of Q3 2026 (one quarter after canonical `skip_if_pipeline_role` ships). Add a deprecation log warning when the alias is used.
2. **Default LLM model per role:** Per the caveat below — do NOT hardcode `"sonnet"` or `"opus"` strings in DEFAULT_PIPELINE_CONFIG. Use model-tier identifiers (`"premium"` / `"mid"` / `"low"`). Initial tier-to-model resolver mapping: premium → opus, mid → sonnet, low → haiku. Assignment: planner=mid, implementer=mid, reviewer=premium, rework_mediator=premium, documentator=mid.
3. **Planner auto-promotion:** No. Human-promotion gate stays the default. Planner ends with `unassign_self`; operator promotes from backlog → active.
4. **Note kinds:** Register three new note kinds in `app.models.notes.kinds`: `plan`, `review_verdict`, `rework_brief`. Each is a closed-set string the validator + scheduler accept.
5. **Documentator `inject_directives`:** Flip from `false` to `true`. Project directives govern docs too.
6. **`pipeline_role` column name:** Confirmed. Use `pipeline_role` (matches the DSL field).
7. **Validator rule #1 warning semantics:** Warn (not error) on missing card-moving terminal unless branch contains a `wake_role` step (which signals intentional handoff to another role). Permissive default; can tighten later.
8. **Pilot-workspace persisted-row disposition:** Wipe with operator (user) consent during smoke-round-6 setup. The persisted row is byte-equal to default except `cleanup_review_notes` drift; let it inherit the new default. This is a user action at smoke-prep time, not an automated migration.
9. **Prompt-template content:** Defer to separate sub-cards on the Backplane board. For this session, ship the skeleton stubs already in the design doc; mark them `TODO: full prompt template — see card <id>` and file one card per role (5 cards: plan, implement, review, mediate_rework, document). The plan/implement/review/document cards are renames of existing prompts so the writing burden is small; mediate_rework is the only fully-new prompt.

### Model-tier abstraction (forward-looking constraint)

The user has flagged that the LLM layer will be abstracted in a future session — Backplane will support multiple providers (Anthropic, OpenAI, etc.) and the pipeline config should not couple roles to a specific model name.

**Therefore:** `pipeline_config.stages[].llm.model` in DEFAULT_PIPELINE_CONFIG must use tier identifiers (`"premium"` / `"mid"` / `"low"`), not provider-specific model names (`"sonnet"` / `"opus"` / `"haiku"`).

For this session:
- The Python config emits tier names.
- A tier-to-model resolver lives in the backend (e.g. `app/services/llm_tiers.py`) that maps `tier → (provider, model)` based on workspace config and/or platform defaults. For this session the mapping can be hardcoded to Anthropic claude-* models; that's fine.
- The Go runner reads the resolved `provider`/`model` from the `/next-assignment` payload (no change to its side).
- Per-workspace overrides of the tier mapping land in a follow-up.

**Do NOT** for this session:
- Build full provider abstraction (out of scope).
- Add UI for tier configuration (out of scope).
- Change the runner-side model handling (it's already `provider+model`-agnostic).

**Do** for this session:
- Emit tier names in DEFAULT_PIPELINE_CONFIG.
- Resolve tier → model in the backend before serving `/next-assignment`.
- Keep the resolver swappable (e.g. a function pointer or a class) so future per-provider tier maps slot in without rewriting callers.

**File a Backplane-board follow-up card titled** `LLM-TIER-ABSTRACTION: per-workspace tier→model overrides + multi-provider mapping`. Owner: future session.

---

## North-star test: rework_mediator generic-primitives audit

Re-enumeration of every primitive the `rework_mediator` role depends on. Each is marked CLOSED-SET (already exists, no work) or NEW PRIMITIVE NEEDED (must be added — filed as follow-up). The user has explicitly forbidden runner-side hardcoding; everything below is either pure config or backend-scheduler / backend-validator changes.

| # | Primitive | Status | Owner | Follow-up card title |
|---|---|---|---|---|
| 1 | `discover` kind | CLOSED-SET | — | n/a |
| 2 | `discover.filters.require_git_repo` | CLOSED-SET | — | n/a |
| 3 | `discover.filters.require_pr_url` | CLOSED-SET | — | n/a |
| 4 | `discover.filters.skip_if_pipeline_role` (rename of `skip_if_participant_role`) | **NEW PRIMITIVE NEEDED** | Backend validator + scheduler | `pipeline_config: rename skip_if_participant_role to skip_if_pipeline_role with back-compat alias` |
| 5 | `discover.filters.require_note_kind: <kind>` | **NEW PRIMITIVE NEEDED** | Backend scheduler filter evaluator + validator | `scheduler: add require_note_kind discover filter (closed set against app.models.notes.kinds)` |
| 6 | `discover.filters.require_note_failure_class: <class>` | **NEW PRIMITIVE NEEDED** | Backend scheduler filter evaluator + validator | `scheduler: add require_note_failure_class discover filter (AND-composes with require_note_kind)` |
| 7 | `claim` kind | CLOSED-SET (kind) / **NEW PARAM** (`pipeline_role`) | Backend `claim` handler + Go runner schema | Part of F-14 fix (see Validation rule #2) |
| 8 | `git_setup` kind, `action: checkout_pr_branch` | CLOSED-SET | — | n/a |
| 9 | `llm` kind, `post_process_kind: produces_note` | CLOSED-SET | — | n/a |
| 10 | `llm.context_sources` `card_notes` filter | CLOSED-SET | — | The note kinds `plan`, `review_verdict`, `rework_brief` must be registered in `app.models.notes.kinds` — small data-model addition, not a primitive. |
| 11 | `mcp_call` kind for non-terminal `create_note` | CLOSED-SET (existing pattern in legacy reviewer) | — | n/a |
| 12 | `mcp_call` kind for `remove_card_participant` | CLOSED-SET | — | n/a |
| 13 | `wake_role` kind targeting `implementer` | CLOSED-SET | — | n/a — `wake_role` accepts arbitrary role names from `roles[]`, no role-awareness. |
| 14 | `apply_label` kind (terminal) | CLOSED-SET | — | n/a |

**NEW PRIMITIVES NEEDED — total: 3 items (#4, #5, #6).**

All three are **backend-scheduler-side** additions: the filter rename is a one-liner with alias, and the two note-attribute filters extend the existing filter evaluator. **No new lifecycle kind**, **no Go runner change**, **no role-keyed logic anywhere**. The Go walker remains entirely role-agnostic; the only place the literal string "rework_mediator" appears in the entire stack is inside the `DEFAULT_PIPELINE_CONFIG.stages[].role` string and the canonical `pipeline_role` filter value — both pure config.

**Degraded-mode fallback** (if 5 and 6 land in a later deploy than the rest): the reviewer's `request_changes` branch adds an `apply_label: needs-rework` step (between `request_changes_write_verdict` and `request_changes_move_back`), and the rework_mediator's discover filter uses the existing `exclude_label` and a new `require_label: needs-rework` filter (which IS a closed-set primitive today — the audit's filter table shows `exclude_label` already exists; `require_label` is its symmetric twin and may also need to be added — flag as **NEW PRIMITIVE NEEDED (degraded path) — `require_label`**, simpler to add than the note-attribute filters). In degraded mode, the role still works but rework status is encoded as a card label instead of a note attribute; the audit's label-as-state-machine antipattern flag applies.

This design ships the role definition in `DEFAULT_PIPELINE_CONFIG` as soon as items #4, #5, #6 land. Until then, the role is documented but not registered in the default; user-authored pipelines on the degraded path can opt in via the label-based variant. The rework_mediator stays a pure-config citizen end to end.
