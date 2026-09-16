# Pipeline Config Reference

> **Status: Superseded and non-authoritative (2026-08-16).** This document
> describes the legacy flat stage model and is retained for compatibility
> archaeology. The current contract is `StageConfig.lifecycle` in
> `runner/internal/valaris/types.go`, validated by the backend and runner, and
> edited through the Pipeline Graph, Advanced Tree, and Advanced Form views.
> Do not author a new pipeline from the examples below.

The `pipeline_config` JSON defines the full runner pipeline for a workspace: which roles exist, what they do, and how they chain. Stored on `workspace_configs.pipeline_config` and fetched by the runner on each heartbeat.

Authoritative types: `runner/internal/valaris/types.go`. Runtime semantics: `runner/internal/workloop/strategy_generic.go`. Validation: `runner/internal/workloop/config_validate.go` (Go) + `backend/app/services/pipeline_config_validation.py` (Python). When in doubt, the code wins — this doc describes the intent.

## Shape

```jsonc
{
  "version": 1,
  "stages": [ /* StageConfig[] */ ],
  "scheduling": {
    "mode": "priority",
    "priority_order": ["reviewer", "orchestrator", "documentator"]
  }
}
```

`stages[*].role` values must be unique within a config. `scheduling.priority_order` must reference only declared roles.

## StageConfig

One stage = one role in the pipeline. Each stage is a ticking function: **discover → claim → git → LLM → sensors → post-action**. Stages with `llm.enabled: false` skip the LLM phase; stages with an empty `sensors` array skip that phase. Any phase can be a no-op by configuration.

```jsonc
{
  "role": "orchestrator",          // unique per pipeline
  "discover":   { /* DiscoverDef */ },
  "claim":      { /* ClaimDef */ },
  "git":        { /* GitDef */ },
  "llm":        { /* LLMDef */ },
  "sensors":    [ /* SensorDef[] */ ],
  "on_success": { /* ActionDef */ },
  "on_failure": { /* ActionDef */ }
}
```

## DiscoverDef

How the stage finds cards.

| Field | Type | Values | Semantics |
|---|---|---|---|
| `strategy` | string | `"unassigned_or_rework"`, `"column_scan"` | Discovery algorithm. See below. |
| `column_type` | string | `"backlog"`, `"active"`, `"review"`, `"done"`, or `""` | With `column_scan`: only cards in this column type are candidates. |
| `column_type_exclude` | string | same set | With `unassigned_or_rework`: exclude this column type from candidates (default pipeline excludes `"done"` for orchestrator). |
| `filters` | map | see below | Composable predicates applied after candidate selection. First match wins on skip. |

**`filters` keys** (any combination):

| Key | Type | Meaning |
|---|---|---|
| `require_git_repo` | bool | Skip cards on boards without a git repo (default `true`). Set `false` to allow non-code cards. |
| `require_pr_url` | bool | Skip cards whose description lacks a PR URL. Used by reviewer/tester stages. |
| `include_label` | string | Restrict candidates to cards carrying this label. Enables label-based role dispatch (`role:researcher`, `role:planner`, etc.). Pushed server-side via the `SearchCards` `label` query parameter. Works on both `column_scan` and `unassigned_or_rework` strategies. |
| `exclude_label` | string | Skip cards already carrying this label. Used by documentator (`"documented"`) and by any stage that marks completion with a label. On conflict with `include_label` (a card carrying both), `exclude_label` wins — a card marked "already handled" is never re-picked. |
| `skip_if_participant_role` | string | Skip cards where the runner is already a participant with this role. The self-skip primitive — any role can express "don't re-visit what I've already done." |
| `skip_self_reviewed` | bool (legacy) | Equivalent to `skip_if_participant_role: "reviewer"`. Kept for back-compat only — prefer the new key. |

Unknown filter keys are silently ignored. **(Known limitation — future work may enforce a filter catalog.)**

## ClaimDef

| Field | Type | Values | Semantics |
|---|---|---|---|
| `participant_role` | string | `"hero"` or `"helper"` | `hero` = primary author (orchestrator). `helper` = secondary participant (reviewer, documentator, tester). |
| `execution_action` | string | free form | Recorded on the `AgentExecution` row. Convention: `implement_card`, `review_card`, `document_card`, `test_card`, etc. Used for filtering in the UI and analytics. |

## GitDef

| Field | Type | Values | Semantics |
|---|---|---|---|
| `action` | string | `"create_branch"`, `"checkout_pr_branch"`, `"none"`, `""` | `create_branch` spawns a fresh branch from default + makes a PR. `checkout_pr_branch` checks out the existing PR branch from the card's description. `none`/`""` skips git entirely. |
| `branch_prefix` | string | free form | Prefix applied to the generated branch name (`"docs-"` for documentator). Empty = use the card ID. |
| `create_pr` | bool | | Whether to `gh pr create` after push. Only meaningful when `action` creates a new branch. |
| `force_push_on_rework` | bool | | On rework ticks, use `git push --force-with-lease` so the single squashed commit replaces prior attempts. |

## LLMDef

| Field | Type | Values | Semantics |
|---|---|---|---|
| `enabled` | bool | | When `false`, the entire LLM phase is skipped. Sensors still run. Decision can still be produced by sensors via `SensorDef.on_pass`/`on_fail`. |
| `stage` | string | free-form when `post_process_kind` is set; otherwise the closed enum `"implement"` / `"review"` / `"document"` | Prompt template lookup key. Resolved first from the platform DB (`prompt_configs` table, keyed by `role:stage`), falls back to the hardcoded Go template of the same name. For custom stages (`post_process_kind` set), a Go fallback exists only for seeded personas (see _Seeded personas_ below). If the platform hasn't cached a template and no Go fallback is registered, the tick short-circuits with decision `"no_prompt"`: the participant claim is released, the execution record is marked `skipped`, and the LLM is NOT invoked. |
| `post_process_kind` | string | `"writes_code"`, `"produces_decision"`, `"produces_note"`, `"mutates_backlog"`, or empty | Discriminator that tells the engine how to handle the LLM output, decoupled from the stage name. See table below. When empty, the legacy closed-enum check on `stage` applies and the kind is derived from the stage name (`implement`→`writes_code`, `review`→`produces_decision`, `document`→`writes_code`). |
| `tools` | string[] | MCP tool names | Allowlist passed to `claude -p --allowedTools=...`. Minimal per role: orchestrator 4, reviewer 2, documentator 5. Empty = no tools. |
| `inject_directives` | bool | | When `true`, Go fetches the board definition's coding standards and pinned notes and injects them into the rendered prompt. Used by orchestrator. Largely superseded by the `board_definition` context source (below); kept for back-compat with the legacy runner-side fetch. |
| `approval_enabled` | bool | | When `true`, the LLM may call `mcp__valaris__request_approval`. The Go loop polls the approval record and resumes the session on decision. Used by orchestrator. |
| `context_sources` | object[] | see _Context sources_ | Backend-rendered context blocks injected into the prompt. See below. |

### Context sources (`llm.context_sources`)

Each entry declares a server-rendered context block. The backend renders the
string at `/next-assignment` time and bundles it in the assignment response;
the runner is a dumb consumer that templates `{{ index .ContextSources "<as>" }}`.
An empty result renders an empty string (never a missing key), so prompt
templates never branch on presence.

| Field | Type | Semantics |
|---|---|---|
| `kind` | string (closed enum) | Which block to render — see table. |
| `as` | string (optional) | Template alias. Defaults to `kind`. Must not collide with a reserved runner field (`card_id`, `pr_url`, `branch`, `workspace`, `board`, `role`, `agent_id`, `board_id`, `execution_id`, `action_plan`, `project_directives`, …). |
| `filter` | object (optional) | Per-kind scoping — see table. |

| `kind` | Filter | What it renders |
|---|---|---|
| `card_notes` | `{kind?: <note_kind>}` | Notes attached to the card, optionally scoped to one note kind. |
| `board_definition` | — | The board definition (scope + 10 structured fields, two-tier MANDATORY/PROJECT CONTEXT) plus board-scoped pinned notes. This is the modern `ProjectDirectives` source. |
| `pinned_notes` | — | Workspace-level pinned notes. |
| `sibling_cards` | `{column_type?, column?, label?, priority?, limit?<=50}` | A generic board scan of other cards. |
| `board_snapshot` | `{include_done?: bool, max_cards_per_column?<=100}` | Full board grouped by column. |
| `review_history` | — | Past reviewer verdict notes on this card (chronological, runner-parity format). |
| `dependency_health` | — | Board dependency-graph faults (cycles / done-conflicts / dangling edges). Renders nothing when healthy. |
| `linked_cards` | `{direction?: depends_on\|blocks\|both, limit?<=50}` | This card's own dependency edges: `DEPENDS ON` prerequisites with done-state, `BLOCKS` downstream cards. Dependency-aware (unlike `sibling_cards`). |
| `execution_history` | `{status?: <ExecutionStatus>, limit?<=50}` | Prior runner runs that touched this card (action, role, model, outcome). Gives rework/implementer roles memory of past attempts. |
| `card_activity` | `{limit?<=50}` | The card's own activity timeline (moves, participant + dependency edits, note creation). |
| `pipeline_expectations` | `{scope?: current_role\|all_roles}` | The pipeline config the runner runs under — rendered from config, not board data. `current_role` (default): this stage's `post_process_kind`, the exact decision vocabulary from its lifecycle `branches` (each decision annotated with its downstream card-visible effect — label changes, column moves), and the allowed tools. Lets a prompt say "emit one of {decisions}" generically so prose can never drift from the lifecycle branches. `all_roles`: a per-role map of the whole pipeline (each role's discover predicates, decision edges, and the labels in play) for a "pipeline plumber" role that diagnoses wedged cards. |

Adding a new kind: write a fetcher in `backend/app/services/agents/context_assembly.py`,
register it in `_FETCHERS`, add the name to `_CONTEXT_SOURCE_KINDS` in
`pipeline_config_validation.py` (the frontend `contextSourceCatalog.ts` drift
test enforces parity), and add filter validation if the kind takes one. No Go
change is needed — `ContextSources` is a raw `map[string]string`.

**`post_process_kind` semantics** (`strategy_generic.go:wrapGenericOutput`):

| Kind | Engine behavior | Typical persona |
|---|---|---|
| `writes_code` | LLM changed files in the working tree. Engine flows into `gitCommitAndPush` and expects a commit + PR. | implementer, documentator, secretary |
| `produces_decision` | LLM emitted a JSON `decision` string. Engine routes through `ActionDef.Branches[decision]`. No git push. | reviewer, triager, QA |
| `produces_note` | LLM emitted research / analysis findings. Engine plumbs them through `CreateReviewNote`. No git push. | researcher, analyst |
| `mutates_backlog` | LLM already wrote side-effects via MCP tools (`create_card`, `update_card`). Engine records the summary only — no git, no note. | planner |

## SensorDef

Computational quality gates that run between LLM and post-action. A sensor failure can either use the legacy aggregated failure path (creates a review note + records failure) or route via `ActionDef.Branches[decision]` when `on_pass`/`on_fail` are set.

| Field | Type | Semantics |
|---|---|---|
| `name` | string | Sensor registry key. Must match a sensor registered in `runner/internal/harness/registry.go`. Validation rejects unknown names when the runner's catalog has been reported to the platform. |
| `config` | map | Sensor-specific config. For `go-test`: `packages`, `timeout`, `tags`. |
| `on_pass` | string | Decision emitted when the sensor passes (e.g., `"pass"`). Feeds `ActionDef.Branches` in post-action. Empty = legacy behavior. |
| `on_fail` | string | Decision emitted when the sensor fails (e.g., `"fail"`). Empty = legacy aggregated failure path (auto review note + fail). |

**Decision precedence** (`strategy_generic.go:deriveDecision`): LLM result decision > sensor decision > empty. An LLM-disabled stage always gets the sensor decision.

**Aggregation** (`runSensors`): multiple sensors run in declared order. First failure wins its `on_fail`. If all pass, last sensor's `on_pass` is the decision.

Registered sensors (query via `GET /api/workspaces/{slug}/sensors`):

| Name | Kind | Purpose |
|---|---|---|
| `go-test` | computational | Runs `go test -json ./...`. Config keys: `packages`, `timeout`, `tags`. |
| `conflict-check` | computational | Runs `git merge-tree` against the default branch to detect merge conflicts before push. Emits one finding per conflicted file with the region count on `Line`. Config keys: `default_branch` (default `"main"`), `timeout` (default `"30s"`). |
| `pr-overlap` | inferential | Flags open PRs in the same repo that touch files overlapping the current branch's diff. Informational only — always passes. Config keys: `repo_slug` (required, e.g. `"owner/repo"`), `default_branch` (default `"main"`), `ignore_pr_number` (optional — useful on rework flows to skip the runner's own PR), `timeout` (default `"30s"`). |

### Example — preventive conflict gate before ship

Wire `conflict-check` into an implementer stage and route `on_fail` through `branches["conflict"]` to bounce the card back to active with a review note instead of shipping a PR that will merge-fail:

```jsonc
{
  "role": "orchestrator",
  "discover": { "strategy": "unassigned_or_rework" },
  "claim":    { "participant_role": "hero", "execution_action": "implement_card" },
  "git":      { "action": "create_branch", "create_pr": true },
  "llm":      { "enabled": true, "stage": "implement" },
  "sensors": [
    { "name": "conflict-check",
      "config": { "default_branch": "main" },
      "on_pass": "",
      "on_fail": "conflict" }
  ],
  "on_success": {
    "conditional": true,
    "branches": {
      "conflict": {
        "move_to_column_type": "active",
        "create_review_note": true,
        "unassign_self": true
      }
    },
    "move_to_column_type": "review"
  }
}
```

## ActionDef

Post-action behavior applied after LLM + sensors complete. `on_success` runs when the stage completed without error; `on_failure` runs on any terminal error (claim failure, git failure, LLM timeout, ship failure).

| Field | Type | Semantics |
|---|---|---|
| `move_to_column_type` | string | `"backlog"`, `"active"`, `"review"`, `"done"`, or `""`. When set, card is moved to this column type. Empty = stay. |
| `stay_in_column` | bool | Explicit opposite of `move_to_column_type`. Used by documentator failure to keep the card in Done. |
| `unassign` | bool | Remove the runner from card participants (both backend and git state). |
| `unassign_self` | bool | Remove only this runner's participation for the current role. Used by reviewer on `request_changes` so the card can be re-reviewed after rework. |
| `wake_roles` | string[] | Roles to wake in the scheduler immediately after this tick. Target must exist in `stages[*].role`. |
| `add_label` | string | Label to add to the card. Used by documentator (`"documented"`) and any stage that marks completion with a label. Generic — does not trigger documentator-specific logic (post-I.1.a). |
| `remove_label` | string | Label to remove from the card. Idempotent (no-op if absent). |
| `cleanup_review_notes` | bool | Delete all prior review notes on the card. Used by reviewer on approve. |
| `create_review_note` | bool | Create a review note from the stage's findings. When the stage was LLM-driven, findings come from the LLM result; when sensor-driven, findings come from the sensor summary. |
| `append_learning` | bool | Append the stage's findings to the board definition under `reviewer_learnings`. Feeds forward into future implementations' directives. |
| `conditional` | bool | When `true`, routing uses `branches[decision]` instead of the flat fields. |
| `branches` | map<string, ActionDef> | Keyed by decision string. Common keys: `"approve"`, `"request_changes"` (reviewer); `"pass"`, `"fail"` (sensor). When the decision key is absent, the base (non-branches) fields are used as fallback. |

**Branches evaluation** (`resolveBranchAction`): if `conditional: true` and the decision key matches a branch, that branch's fields replace the base action entirely. Other base fields are NOT merged — each branch is self-contained.

## SchedulingDef

| Field | Type | Values | Semantics |
|---|---|---|---|
| `mode` | string | `"priority"` (default), `"round_robin"` | `priority` picks the first role in `priority_order` with claimable work every tick. `round_robin` advances one slot through `priority_order` per tick, skipping roles currently in idle cooldown. |
| `priority_order` | string[] | | Order roles are offered a chance to tick. Must reference only declared roles. |

Deprecated (tolerated for backwards compat, runtime ignores them): `max_consecutive_same_role`, `max_consecutive`, `starvation_prevention`. Use explicit `mode` instead — the old consecutive/starvation guards overrode operator-declared priority intent.

## Example — Default pipeline

See `DEFAULT_PIPELINE_CONFIG` in `backend/app/services/workspace_config.py` — the 7-role pipeline (planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler) the backend lazy-seeds to `workspace_configs.pipeline_config` on first access.

## Example — 4-stage pipeline with tester role (hypothetical)

```jsonc
{
  "version": 1,
  "stages": [
    { "role": "orchestrator", /* ... unchanged ... */ },
    {
      "role": "tester",
      "discover": {
        "strategy": "column_scan",
        "column_type": "review",
        "filters": {
          "require_pr_url": true,
          "skip_if_participant_role": "tester",
          "require_git_repo": true
        }
      },
      "claim": { "participant_role": "helper", "execution_action": "test_card" },
      "git":   { "action": "checkout_pr_branch" },
      "llm":   { "enabled": false },
      "sensors": [
        { "name": "go-test", "on_pass": "pass", "on_fail": "fail" }
      ],
      "on_success": {
        "conditional": true,
        "branches": {
          "pass": { "wake_roles": ["reviewer"] },
          "fail": {
            "move_to_column_type": "active",
            "create_review_note": true,
            "unassign_self": true,
            "wake_roles": ["orchestrator"]
          }
        }
      },
      "on_failure": { "move_to_column_type": "backlog", "unassign": true }
    },
    { "role": "reviewer",     /* ... unchanged ... */ },
    { "role": "documentator", /* ... unchanged ... */ }
  ],
  "scheduling": {
    "mode": "priority",
    "priority_order": ["tester", "reviewer", "orchestrator", "documentator"]
  }
}
```

## Validation

Pipeline configs are validated at two points:

1. **Backend, on write** (`POST/PUT workspace config`): rejects malformed configs with 422 + structured error list.
2. **Go, on read** (each poll cycle): reports `ConfigError` entries via heartbeat — the runner still runs with the bad config, but the platform surfaces the errors on the runner detail page.

Error codes (identical on both sides): `invalid_wake_role`, `invalid_move_to_column_type`, `unknown_discover_strategy`, `unknown_claim_role`, `unknown_git_action`, `unknown_llm_stage`, `unknown_post_process_kind`, `duplicate_stage_role`, `priority_order_unknown_role`, `unknown_sensor_name`, `missing_stage_key` (backend only).

Sensor-name validation is skipped when no runner has yet reported a `sensor_catalog` for the workspace — so operators can author configs referencing custom sensors before the first runner starts up.

## Seeded personas (custom stages with hardcoded fallbacks)

The platform seeds a library of default prompts on first workspace access (see `backend/app/services/agents/prompt_defaults.py`). Two of those entries are *custom stages* — their stage names are outside the legacy `{implement, review, document}` enum and dispatch through `post_process_kind`. The runner also ships hardcoded fallbacks for them so a fresh runner can run before the platform has seeded the cache.

| Role | Stage | `post_process_kind` | Purpose |
|---|---|---|---|
| `researcher` | `research` | `produces_note` | Investigate a topic, emit structured markdown findings, captured as a board review note. Pair with `create_review_note: true` on success. |
| `planner` | `plan` | `produces_note` | Write one plan note per card describing how the implementer should approach the work; the lifecycle persists `findings` as a `kind=plan` note. Creates no cards or notes itself. Emits `decision` (`"planned"` / `"needs_research"`) for routing. |

Any other custom stage name (e.g., `triage`, `security_audit`) still works — but requires an operator-supplied prompt in `prompt_configs`. Without it, the tick short-circuits with decision `"no_prompt"`.

### Example — 5-stage pipeline (researcher → planner → implementer → reviewer → documentator)

Label-based role dispatch (`role:researcher` etc.) plus lifecycle filters keep each stage picking up only its cards. Planner's `"planned"` decision hands control back to the scheduler; the backlog it created is processed by the implementer on the next tick. The `planner` here is a CUSTOM decomposer that replaces the shipped default planner (`produces_note`, no card creation): it runs as `mutates_backlog` and is granted `list_notes`/`create_card`/`update_card` so it can write the backlog itself.

```jsonc
{
  "version": 1,
  "stages": [
    {
      "role": "researcher",
      "discover": {
        "strategy": "column_scan",
        "column_type": "backlog",
        "filters": { "include_label": "role:researcher", "require_git_repo": false, "skip_if_participant_role": "helper" }
      },
      "claim": { "participant_role": "helper", "execution_action": "research_card" },
      "git":   { "action": "none" },
      "llm":   { "enabled": true, "stage": "research", "post_process_kind": "produces_note", "tools": ["mcp__valaris__get_project_context", "mcp__valaris__get_card", "mcp__valaris__list_notes", "WebSearch", "WebFetch"] },
      "on_success": { "move_to_column_type": "done", "create_review_note": true, "wake_roles": ["planner"] },
      "on_failure": { "move_to_column_type": "active", "unassign_self": true }
    },
    {
      "role": "planner",
      "discover": {
        "strategy": "column_scan",
        "column_type": "backlog",
        "filters": { "include_label": "role:planner", "require_git_repo": false, "skip_if_participant_role": "helper" }
      },
      "claim": { "participant_role": "helper", "execution_action": "plan_card" },
      "git":   { "action": "none" },
      "llm":   { "enabled": true, "stage": "plan", "post_process_kind": "mutates_backlog", "tools": ["mcp__valaris__get_project_context", "mcp__valaris__get_card", "mcp__valaris__list_notes", "mcp__valaris__create_card", "mcp__valaris__update_card"] },
      "on_success": {
        "conditional": true,
        "branches": {
          "planned":        { "move_to_column_type": "done",   "wake_roles": ["orchestrator"] },
          "needs_research": { "move_to_column_type": "active", "create_review_note": true, "wake_roles": ["researcher"] }
        }
      },
      "on_failure": { "move_to_column_type": "active", "unassign_self": true }
    },
    { "role": "orchestrator",  /* default implementer — filter on role:implementer label */ },
    { "role": "reviewer",      /* default */ },
    { "role": "documentator",  /* default */ }
  ],
  "scheduling": {
    "mode": "priority",
    "priority_order": ["reviewer", "researcher", "planner", "orchestrator", "documentator"]
  }
}
```

## What's NOT yet configurable

These are known limitations that require engine work to unlock:

- ~~**LLM stage enum is closed**: `implement`, `review`, `document`~~ — **Resolved in I.1.g.** Any stage name works when `llm.post_process_kind` is set. The platform prompt cache provides the template; no engine changes needed to add a persona.
- **Skills as bundles**: tools + prompt partials + rules as named reusable units. Phase I.3 territory.
- **Cross-stage context**: a stage can't currently read another stage's output (beyond participant state + review notes). Blackboard-pattern primitives would help.
- **Filter catalog**: unknown `filters` keys are silently ignored. No enumeration.
