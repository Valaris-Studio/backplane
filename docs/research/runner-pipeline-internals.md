# Runner, Agent Team, Pipeline & Git Internals

*Research note — 2026-04-19. Scope: `intern/` Go client, `backend/app/services/agents/*`,
`backend/app/services/workspace_config.py`, `backend/app/services/approvals/*`,
`backend/app/services/git/*`, and the pipeline-config contract the three of them
share.*

This document is intentionally plain-prose and file-referenced. It does not
replace the code — it orients a new reader to the moving parts so the code
itself can be read in the right order.

---

## 1. What is a Runner

### Plain-language definition

A **Runner** is a credentialed long-running process that an operator launches
on their own machine (laptop, VM, k8s pod). It logs into the Valaris backend
with an API key, fetches its platform-authored configuration, and then loops:
poll → claim a card → execute one or more LLM roles against it → ship →
repeat. One API key = one runner = one OS process.

The word "Runner" is the user-facing term for concept A in the vocabulary
migration (`memory/vocabulary_runner_migration.md`). Internally, schema and
code still say "Agent" (`Agent` model, `/api/agents/...`, Go `AgentConfig`);
only UI copy has been renamed so far.

### Technical definition

- **Binary**: `intern` (Go, `intern/cmd/intern/main.go`). Single static binary.
  Distributed as source today — operators run `go build ./cmd/intern` or use
  the Dockerfile at `intern/Dockerfile`.
- **Backing record**: a row in the `agents` table (`backend/app/models/agents/agent.py:21`).
  Holds `api_key_id`, `allowed_workspaces` (JSON slug list), `allowed_actions`,
  `budget_usd`, per-runner rate limit `max_requests_per_minute`, and a fleet of
  `health_*` heartbeat columns.
- **Identity**: `ValarisConfig.APIKey` (`intern/internal/config/config.go:53`)
  is the Bearer `vlr_...` token. `client.Init(ctx)` calls
  `GET /api/me` then `GET /api/agents/me` (`intern/internal/valaris/client.go:43-55`).
- **Config**: a YAML file (path via `-config`) plus the platform config pulled
  at startup via `GET /api/agents/me/config` (see `AgentService.get_agent_config`
  at `backend/app/services/agents/agent.py:282`).
- **Lifecycle**:
  1. **Registration (human)**. User creates the runner in the UI
     (`POST /api/agents/...`). Backend mints an API key, returns it once.
     Idempotent on `(owner, name)` — a repeat create returns the existing row
     (`backend/app/services/agents/agent.py:36-44`).
  2. **Team-add (human)**. Runner joins one `AgentTeam`; membership carries
     `roles: list[str]` — the pipeline roles this runner is authorized to play
     (`backend/app/models/agents/team.py:36`).
  3. **Bootstrap (binary)**. Operator launches `intern -config intern.yaml`
     on their own hardware. `main.go:37-111` loads config, authenticates,
     resolves identity, builds the Git manager, the LLM provider, the health
     collector, and the `workloop.Loop`.
  4. **Platform-authority fetch**. `Loop.New` calls `GetPlatformConfig` and
     **refuses to start** when the backend returns no `pipeline_config` or no
     stages (`intern/internal/workloop/loop.go:120-131`). The runner does not
     carry a local default pipeline at runtime — this is a deliberate
     "backend-authoritative" contract (`memory/feedback_backend_authoritative_config.md`).
  5. **Loop**. `Loop.Run` (`loop.go:498`) ticks on `cfg.WorkLoop.PollInterval`
     (default 2 min) or on WS trigger. Each tick: heartbeat → refresh prompt
     cache → refresh platform config → apply platform authority → `tick()`.
  6. **Shutdown**. SIGINT/SIGTERM → `hc.SetStatus("draining")`, loopCtx
     cancelled, drain up to `DrainTimeout` (60s default), then rootCtx
     cancelled. Second signal forces immediate shutdown (`main.go:146-161`).

### What runs where

| Process | Where | Purpose |
|---|---|---|
| `intern` Go binary | Operator's host | Poll, claim, orchestrate git + LLM |
| `claude` CLI subprocess | Operator's host, spawned per stage by `intern` | Runs the actual LLM call; MCP tools wire back to the backend |
| Valaris backend | Cloud Run (the production GCP project, `us-central1`) | REST + WS API, pipeline config, approvals, persistence |
| MCP server | Operator's host (via `run.sh`) | Exposes Valaris REST surface as MCP tools to the claude subprocess |

Each `intern` binary spawns `claude -p` per stage (`intern/internal/llm/claude_cli.go:73-154`).
ANTHROPIC_API_KEY is deliberately stripped from the subprocess env so Claude
Code Max (OAuth/subscription) wins unless the operator sets
`llm.anthropic_api_key` explicitly (`config.go:217-220`, `claude_cli.go:92-95`).

---

## 2. What is an Agent Team

An **AgentTeam** is the pairing layer between runners (concept A) and roles
(concept B). A team lives in a workspace (optionally scoped to a board) and
contains zero or more `AgentTeamMember` rows — each member is one runner
mapped to a list of role strings.

Schema:

- `AgentTeam` (`backend/app/models/agents/team.py:11`) — `workspace_id`,
  nullable `board_id`, `slug`, `is_active`.
- `AgentTeamMember` (`team.py:36`) — `(team_id, agent_id)` composite PK plus
  `roles: JSON` (free-form string list).

Business rules in `TeamService` (`backend/app/services/agents/team.py`):

- Team slugs are unique per workspace; idempotent create returns the existing
  team (lines 37-42, per `feedback_idempotent_mutations.md`).
- Adding a member is idempotent: if the agent is already a member, roles are
  overwritten rather than conflicting (lines 149-159).
- **Unique-role enforcement** (lines 139-147): a role declared `unique: true`
  in `pipeline_config.stages[]` may only be staffed by one member in a team.
  The legacy three-role set (`orchestrator`, `reviewer`, `documentator`) is
  grandfathered into `unique=True` by `canonicalize_pipeline_config`
  (`backend/app/services/pipeline_config_validation.py:48-75`). Newly-defined
  custom roles default to non-unique unless the operator sets the flag.

### Team vs Runner

- A runner is a credential + process identity.
- A team is a membership graph that says "this runner plays these roles in
  this workspace". The runner's effective roles on a given workspace come from
  the intersection of team membership and the pipeline's stage roles
  (`intern/internal/workloop/loop.go:149-169`).
- `get_agent_team_info(agent_id)` returns the **first** active team an agent
  is in (`team.py:289-305`). One runner can technically be in multiple teams,
  but the runner only picks up the first one today. This is a known
  limitation and the relationship is exposed as 1:1 in the UI.

The rename migration keeps `AgentTeam` as the class/table name; only UI copy
says "Team" (not "Agent Team").

---

## 3. Roles

### Role inventory

Roles are free-form strings in `pipeline_config.stages[].role`. The legacy
three — shipped as `DEFAULT_PIPELINE_CONFIG`
(`backend/app/services/workspace_config.py:21-170`) — plus the researcher and
planner stages from Phase I.1.h are documented with prompt defaults in
`backend/app/services/agents/prompt_defaults.py`:

| Role | Canonical stages (LLM) | Purpose |
|---|---|---|
| `orchestrator` | `implement`, `implement_after_approval`, `mediate_rework`, `rework_implement` | Claim unassigned/rework cards, implement code, request approval for destructive ops |
| `reviewer` | `review` | Check out the PR branch, decide approve / request_changes via StructuredOutput |
| `documentator` | `document` | Update docs, add the `documented` label when shipped |
| `researcher` | `research` | Investigate a card topic; emit findings as a board note (`produces_note`) |
| `planner` | `plan` | Decompose a high-level card into implementable cards (`mutates_backlog`) |

Legacy non-LLM stages (`discover`, `claim`, `ship`, etc.) are registry entries
the UI shows but which Go never queries — Go owns those via direct REST +
deterministic code (see the comment block at `prompt_defaults.py:10-19`).

The **MCP server description** (`mcp-server/src/valaris_mcp/server.py`) still
mentions older personas: "Project Initializer", "Secretary / Manager",
"Architect / Orchestrator", "Coding Agent". Those are free-string prompt
workflow labels, not rows in any enum — they are user-facing prompts for
humans driving MCP manually, not roles in the platform pipeline.
`vocabulary_runner_migration.md` tracks the rewrite in Phase 2.

### How a role is "run"

A role in `pipeline_config.stages[]` is bound to a `DataDrivenStrategy` at
runner startup (`intern/internal/workloop/strategy.go:25-36`). The strategy
implements a single `Tick` method
(`intern/internal/workloop/strategy_generic.go:32-118`) whose shape is:

1. **Discover** — query backend for cards matching this role's `DiscoverDef`.
2. **Budget + circuit-breaker gate** — fail-closed on budget read failure.
3. **Claim** — call the role's `ClaimDef` (participant role hero/helper,
   execution action).
4. **Git setup** — based on `GitDef.Action`: `create_branch` (orchestrator,
   documentator), `checkout_pr_branch` (reviewer), or `none` (for
   secretary/planner-style roles whose work is note-only).
5. **LLM phase** — if `LLMDef.Enabled`, spawn `claude -p` with the stage
   prompt and the declared `tools` allowlist.
6. **Post-process** — decided by `LLMDef.EffectivePostProcessKind`
   (`intern/internal/valaris/types.go:272`): `writes_code` →
   `gitCommitAndPush`; `produces_decision` → route via `ActionDef.Branches`;
   `produces_note` → `CreateReviewNote`; `mutates_backlog` → no-op (the LLM
   already called MCP tools).
7. **Action** — apply `OnSuccess` / `OnFailure` / branch-specific action:
   move column, add/remove label, wake downstream roles, unassign, etc.

### Role chain (legacy 3-role flow)

```
operator           backlog                     active                     review                     done
                     │                           │                           │                           │
unassigned ─────────►│                           │                           │                           │
                     │ orchestrator.discover     │                           │                           │
                     │ orchestrator.claim  ────► │                           │                           │
                     │ implement + commit + push │                           │                           │
                     │ orchestrator.ship  ───────┼─────────────────────────► │                           │
                     │                           │                           │ reviewer.claim            │
                     │                           │                           │ review (StructuredOutput) │
                     │                           │                           │                           │
                     │                    ◄──────┼─── request_changes        │                           │
                     │                           │                           │     approve ──────────────┼──►
                     │                           │                           │                           │ documentator.claim
                     │                           │                           │                           │ document
                     │                           │                           │                           │ add label "documented"
```

Custom roles added to the pipeline slot into this chain via `wake_roles` and
column-type targets, not via hardcoded switches.

---

## 4. Pipelines

A **pipeline** is one `pipeline_config` dict living on `WorkspaceConfig`.
Schema: `pipeline_config` JSON column on `workspace_configs`. Shape documented
at `backend/app/services/workspace_config.py:21-170` and mirrored on the Go
side at `intern/internal/valaris/types.go:171-329`.

### Shape

```
pipeline_config = {
  version: int,
  stages: [StageConfig, ...],
  scheduling: {
    mode: "priority" | "round_robin",
    priority_order: [role, role, ...],
    min_failure_backoff_seconds: int,
  }
}

StageConfig = {
  role: str,                   # free-form
  unique: bool,                # unique role per team
  discover: DiscoverDef,       # strategy + filter dict
  claim: ClaimDef,             # hero|helper + execution_action
  git: GitDef,                 # action + branch_prefix + create_pr
  llm: LLMDef,                 # stage, tools, post_process_kind, directives
  sensors: [SensorDef, ...],   # e.g. go-test, eslint
  on_success: ActionDef,       # may have branches keyed by decision
  on_failure: ActionDef,
}
```

### Flow of a card through the pipeline

1. **Discover** finds a card and returns a `discoverResult` (JSON blob with
   `card_id`, `board_id`, `git_repo_url`, optional `rework: true` and
   `review_feedback`). Orchestrator uses `unassigned_or_rework` strategy;
   reviewer/documentator use `column_scan`.
2. **Claim** is atomic at the backend: `claim_card`
   (`backend/app/services/kanban/card.py:420`) locks the card row
   (`get_for_update`), checks no existing hero, adds the agent as hero, moves
   the card to "In Progress". Returns 409 if already claimed.
3. **LogExecutionStart** / **LogExecutionUpdate** records the work in
   `agent_executions` (`backend/app/models/agents/execution.py:29`). The role
   field was historically hardcoded as `"orchestrator"` on the hero path; the
   audit at `memory/audits/audit_intern_go.md` flags this as a role-propagation
   bug (loop.go:914, 1091) scheduled for rename work (T1.1).
4. **Execute** — claude subprocess runs the rendered prompt with the allowed
   MCP tools. Structured output parsed from stream-json.
5. **Post-action** — the `ActionDef` is executed. Conditional branches let
   reviewer emit `approve` / `request_changes` and route to different column
   types, wake roles, create review notes, and append findings to the
   definition (`append_learning`).
6. **LogExecutionUpdate (completed)** closes the execution with cost and
   tokens.

### Approval gate

Destructive operations route through the approval system
(`backend/app/services/approvals/approval.py`). Flow:

- LLM emits `request_approval(category, action_description, action_payload)`
  via MCP.
- Risk score is computed (`approvals/risk.py`); if below
  `AUTO_APPROVE_THRESHOLD`, status = `auto_approved` immediately.
- Otherwise status = `pending`; backend publishes an `approval.created` event.
- The `intern` loop was subscribed via `ApprovalSubscriber`
  (`loop.go:28-34`) — WS wakes the loop when the approval is decided, instead
  of HTTP polling every 30s. HTTP polling remains as a fallback.
- On approve, the orchestrator's next tick picks the card back up using the
  `implement_after_approval` stage prompt.

Execution states: `started → running → completed | failed | aborted | skipped`
(`ExecutionStatus` enum, `execution.py:15-26`). `skipped` is the graceful
"no prompt authored yet" terminal — the runner returns without running an
LLM call so the UI can surface the gap.

### Scheduling

The runner's `StrategyScheduler` (`intern/internal/workloop/scheduler.go`)
picks which role runs each tick. Modes:

- **priority** — iterate `priority_order` left-to-right; return the first
  non-cooling strategy. Roles with no work are put on a 4-minute idle cooldown.
- **round_robin** — rotate through `priority_order`, skipping cooling roles.

Platform authority is re-checked every tick: if a role's LLM stage has no
prompt in the cache, it is dropped from the live scheduler by
`applyPlatformAuthority` (`loop.go:302-343`). Authoring the prompt restores
the role on the next refresh without restart.

### Platform authority principle

Two cooperating mechanisms:

- Backend is authoritative for **pipeline shape and prompts** (see
  `feedback_backend_authoritative_config.md`, `feedback_context_augmentation.md`).
- Go runner refuses to boot without a platform pipeline
  (`loop.go:125-147`) and drops roles whose prompt is missing rather than
  falling back to a compiled-in template.

The audit (`audit_intern_go.md`) flags two current violations worth fixing:

- `intern/internal/workloop/pipeline_config.go:8-147` still carries a full
  hardcoded 3-role `DefaultPipelineConfig`. It is dead on the runtime hot
  path, but `config_validate.go:124,145` still references it for validation —
  so validation output can disagree with the actual refusal-to-start.
- The scheduling defaults in `config.go:175` (the `MaxConsecutive`,
  `StarvationPrevention` fields) and the `Git` defaults at `config.go:155-163`
  leak operator-set values that the platform should own.

---

## 5. Prompt configs

### Storage

Per-stage prompts live in `agent_prompt_configs`
(`backend/app/models/agents/prompt_config.py:10`). Keyed by
`(workspace_id, team_id, team_role, stage, slug)` unique constraint.

- `content` holds the Go `text/template` source the runner renders with
  `PromptContext` (workspace slug, agent ID, board ID, card ID, execution ID,
  plus stage-specific fields like `ReviewHistory`, `ActionPlan`,
  `ProjectDirectives`).
- `resolved_content` is backend-assembled — it splices the post-process
  imperative (see `_POST_PROCESS_IMPERATIVES` at `prompt_defaults.py:715-738`)
  into the operator-authored body. The runner prefers `resolved_content`
  (`types.go:120-128`, `EffectivePromptContent`); this closes B11 from the
  walkthrough below.

### Defaults, synthesis, overrides

Three layers on the backend side:

1. **Registry** (`PROMPT_STAGE_REGISTRY` at `prompt_defaults.py:26`). 21
   hand-written stage defaults for the five platform-shipped roles. Comment
   at the top of the file calls out the "stage == slug" sync rule for the
   8 live stages Go actually queries.
2. **Synthesis** (`synthesize_missing_defaults` at `prompt_defaults.py:748`).
   For any `(role, stage)` in the workspace pipeline that is NOT in the
   registry, a placeholder is generated from `MINIMAL_AGENTIC_PROMPT_TEMPLATE`
   so the UI always has something to author against — custom roles are never
   second-class citizens.
3. **Overrides** — `AgentPromptConfig` rows authored per workspace / team /
   role / stage. The `content` replaces the registry default; the
   backend re-splices the post-process imperative.

Go side caches prompts in `promptCache` keyed by `role:stage`
(`loop.go:71-73`). `getPrompt` falls back from the role-qualified key to the
bare stage for backward compat; `resolvePrompt` falls back to the Go
hardcoded template for the five known stages, or calls
`renderMinimalAgenticPrompt` (`intern/internal/workloop/prompts_minimal.go`)
for opt-in custom roles (`LLMDef.UseMinimalPromptWhenUnauthored`, default
false — safest is to graceful-skip).

### Per-role LLM provider / model

Today only a single `LLMConfig` lives on the runner YAML
(`intern/internal/config/config.go:64-84`). `ModelForPhase` looks up a
per-phase override (`model_overrides`) but all routes to the same provider
(`claude-cli`). Per-role provider is NOT YET wired end-to-end — this is
explicitly the north-star next step captured in
`memory/feedback_llm_abstraction_north_star.md` and tracked in
an internal scoping note (not exported).

What that memory calls out:

- Role extensibility without model extensibility caps the platform. Implementer
  on Sonnet + reviewer on GPT-5 + documentator on Gemini — all from one
  runner — is the declared target.
- Any design that assumes one-model-per-runner is a half-answer.
- Self-review / same-runner-as-reviewer guards (e.g. the hardcoded
  `p.Role == "reviewer"` at `loop.go:1604`) are not correctness invariants —
  they are pre-abstraction heuristics.

### Context augmentation

Per `feedback_context_augmentation.md`: all mandatory context
(project directives, review history, card context) must be fetched by Go
code (not by the LLM via MCP tool calls) and injected into the prompt as
`=== SECTION (MANDATORY) ===` blocks. The runner implements this for:

- **Project directives** — `inject_directives: true` on the stage pulls
  definition + pinned notes and renders them into the prompt context field
  `{{.ProjectDirectives}}`.
- **Review history** — `mediate_rework` stage receives pre-fetched review
  notes as `{{.ReviewHistory}}` (prompt_defaults.py:215-217).
- **Action plan** — `rework_implement` receives `{{.ActionPlan}}`
  (prompt_defaults.py:291-293).

This pattern exists because Sonnet treated tool-call results as optional
reference (`feedback_directive_compliance.md`) and rework LLM calls
repeatedly failed to fix clearly described issues when feedback was passed
as prose (`feedback_review_context_quality.md`).

---

## 6. Git capabilities

### What `GitRepo` is

`GitRepo` (`backend/app/models/git/git_repo.py:18`) binds a git URL to a
board. Fields: `url`, `provider` (github|gitlab|bitbucket|other),
`default_branch`, `slug` (unique per board), `require_branch_protection`.
The runner uses these when setting up git for a card on the associated board.

### What the runner does with git

The Go `git.Manager` (`intern/internal/git/git.go:19`) owns git operations
directly — deliberately not delegated to the LLM because git state management
needs deterministic control.

Implemented operations:

| Method | Purpose | File:line |
|---|---|---|
| `CloneOrOpen` | Clone or fetch a repo | `git.go:28` |
| `FetchAndResetDefault` | Hard-reset the default branch to origin | `git.go:54` |
| `CreateBranch` | Branch off fresh default, recover on collision | `git.go:95` |
| `CheckoutBranch` | Used by reviewer to switch to a PR branch | `git.go:133` |
| `HasChanges` / `CommitAll` | Stage + commit all changes | `git.go:165, 177` |
| `Push` / `ForceWithLeasePush` | Push; rework uses `--force-with-lease` | `git.go:201, 299` |
| `ResetToDefault` / `Cleanup` | Return repo to clean default-branch state | `git.go:217, 234` |
| `CreatePR` | `gh pr create`; returns existing URL on duplicate | `git.go:255` |
| `SquashOnto` | Collapse branch into one commit on base | `git.go:323` |
| `EnsureBranchProtection` | Apply branch-protection policy via `gh api` | `git.go:525` |
| `EnsureAutoMergeEnabled` | Flip repo `allow_auto_merge=true` | `git.go:585` |
| `EnableAutoMerge` / `IsAutoMergeArmed` / `MergePR` | Arm or directly merge a PR | `git.go:682, 652, 710` |

Safety: force-push refuses to touch `main` or `master` and refuses any branch
that does not carry the configured `BranchPrefix` (`git.go:305-309`).

### Scaffolding

There is no "scaffold a new repo" runner flow today. Board-repo linkage is
manual (`POST /api/workspaces/{slug}/boards/{id}/git-repos`). The
`project-initializer` persona in the MCP server description refers to a
bootstrap workflow driven by a human via the MCP client, not a runner
automation — it creates boards, columns, definitions and cards but does not
create repos. Creating repos automatically is not wired.

### Review on GitHub

`GitConfig.ReviewMode` (`intern/internal/config/config.go:94`) chooses:

- `platform` (default, single-identity installs) — the reviewer posts verdicts
  as comments / review notes back into Valaris. Cannot self-approve a PR
  because the runner authors it.
- `github` — a formal `gh pr review` requires a second identity (e.g., a
  GitHub App). Not the default.

### Merge trigger

`GitConfig.MergeTrigger` is either `on_ship` (default — the orchestrator arms
auto-merge when it ships) or `on_approve` (wait for reviewer approval). Both
paths go through `EnableAutoMerge` → GitHub handles the actual merge when
required status checks pass.

### What's NOT implemented

- No repo scaffolding or template-clone from a runner.
- No non-GitHub auto-merge today (`EnsureBranchProtection`,
  `EnsureAutoMergeEnabled` use `gh api`).
- No WebUI-driven merge from Valaris: merge happens via GitHub's own
  auto-merge or via `gh pr merge` shelled by the runner.

---

## 7. Card lifecycle through a runner

Tying it together for a default-config card:

1. **Pickup**. Orchestrator's discover strategy `unassigned_or_rework` returns
   either a rework card (hero=this agent, column=active, with review_feedback
   in description) or a new unassigned card. `claim_card`
   (`card.py:420-461`) locks the row, adds a hero participant, and moves the
   card to "In Progress".
2. **Git setup**. `CloneOrOpen` the board's git repo, `CreateBranch` off the
   default branch with `{branch_prefix}{card_id}` as the branch name.
3. **Implement**. `claude -p` with the `implement` stage prompt + MCP tools
   `get_card`, `get_project_context`, `log_execution_update`,
   `request_approval`. The LLM edits files directly in the working tree;
   the runner commits. If the LLM emits `status: needs_approval`, the runner
   yields and the approval path takes over until a decision arrives.
4. **Commit + push**. `CommitAll` with the rendered commit-message template
   (default `feat({{.CardID}}): {{.Title}}`), then `Push` or
   `ForceWithLeasePush` for rework. `CreatePR` opens the PR.
5. **Ship**. Orchestrator appends branch + PR to card description, moves to
   the `on_success.move_to_column_type` column (typically "Review"), and
   wakes the `reviewer` role in the scheduler (`wake_roles: ["reviewer"]`).
6. **Review**. Reviewer's discover picks up cards in review column with a PR
   URL. `CheckoutBranch` on the PR branch. The `review` stage runs with
   StructuredOutput enforcing `{decision, summary, findings}`. Branching
   `on_success.branches["approve"|"request_changes"]` decides next move:
   approve → "Done" + wake documentator + cleanup review notes; reject →
   "Active" + create review note + append_learning + unassign_self so the
   orchestrator can pick up a rework pass.
7. **Rework (if rejected)**. Orchestrator's discover sees the hero-assigned
   active card with `review_feedback` in the description. `mediate_rework`
   stage builds an action plan (`{{.ReviewHistory}}` pre-fetched). Then
   `rework_implement` stage applies the action plan. Force-with-lease push
   the existing branch. Move back to Review.
8. **Document**. Documentator's discover finds cards in "Done" without a
   `documented` label. `document` stage updates docs; `tag_documented`
   stage adds the label and the card stays in Done.

Rework cycles are capped by workspace `max_rework_attempts` (default 3 on the
backend, same default on Go if the platform returns zero —
`loop.go:100-111`). After the cap, the card is blocked by the circuit breaker
and surfaces in the heartbeat `BlockedCards` field.

---

## 8. Communication channels

The north-star principle (`feedback_ws_first_communication.md`): if it can go
over WebSockets, it does; HTTP is reserved for REST RPCs and external
webhooks.

### WebSocket

`intern/internal/events/client.go` connects to
`/ws/workspaces/{slug}/events?token={api_key}` (line 44). Subscribes to
`card.*`, `approval.*`, `execution.*`, `config.*`, `agent.*` (line 105-107).

Uses today:

- **Poll trigger**. Any subscribed event wakes `Loop.TriggerPoll`, short-
  circuiting the 2-minute poll interval.
- **Approval wait**. `SubscribeApproval(approvalID, ch)` lets the loop
  block-and-wake on a specific approval decision instead of HTTP polling.
- **Heartbeat (WS-2)**. `SetHeartbeatSender(wsClient)` makes heartbeats fly
  as WS frames. HTTP `POST /api/agents/me/heartbeat` remains the fallback
  when the WS is disconnected (`loop.go:603-623`).
- **Poll command**. Backend publishes `agent.poll_requested` from
  `AgentService.poll_agent` — `POST /api/agents/{id}/poll` requires an open
  WS connection (503 otherwise) and pushes the event to the specific runner
  (`backend/app/services/agents/agent.py:194-213`).

### HTTP

Still REST:

- Startup identity: `GET /api/me`, `GET /api/agents/me`.
- Config refresh: `GET /api/agents/me/config`, `GET /api/.../prompt-configs`.
  These fire every pollCycle today; the audit calls out that they should
  collapse into `config.*` event handlers (Batch F in `audit_intern_go.md`).
- Deterministic kanban mutations: `claim_card`, `move_card`, participant
  add/remove, create_note, etc. Go client calls these directly via
  `intern/internal/valaris/client.go` (902 lines of thin REST wrappers).

### LLM channel

`claude -p` spawned per stage. The claude subprocess receives the prompt via
stdin-style arg (`-p prompt --verbose`), an MCP config path, and an allowed
tools list. The MCP server the subprocess connects to is operator-local
(`mcp-server/run.sh`) and proxies to the backend. Streamed JSONL output is
parsed in `intern/internal/llm/stream.go`; `result.StructuredOutput` is
cleared on non-zero exit so crashed subprocesses cannot emit a misleading
decision (`claude_cli.go:128-141`).

---

## 9. Known bugs and limitations

Honestly framed from `memory/audits/runner-launch-walkthrough-2026-04-18.md`
(operator walkthrough) and `memory/audits/audit_intern_go.md`. These are
point-in-time snapshots — verify before acting. The walkthrough proved the
pipeline executes end-to-end with a custom role + custom prompt; the issues
below are friction on the path to "go", not engine failures.

### From the walkthrough (B1-B11)

- **B1 — scheduling defaults override platform config.** `config.go`'s
  `defaults()` historically pre-populated `Scheduling.PriorityOrder` so the
  override check in `loop.go` was always true, silently dropping custom roles.
  The current code has been tightened: `defaults()` leaves `PriorityOrder`
  empty (`config.go:180-186`) and `loop.go` adds an `appendMissingRoles`
  seatbelt (`loop.go:276-291`). Worth double-checking during refactors —
  directly ties to the "backend authoritative" principle.
- **B2 — pipeline editor doesn't auto-extend `priority_order` on new roles.**
  Backend `canonicalize_pipeline_config` now appends missing stage roles in
  stage-definition order (`pipeline_config_validation.py:60-85`), closing
  half the issue. The frontend pipeline builder still doesn't surface the
  scheduling order.
- **B3 — metrics filter excludes runners with null `allowed_workspaces`.**
  A null allowlist means "no restriction" elsewhere but means "invisible" in
  `metrics.py`. Needs one reading chosen and documented. Auto-populating
  `allowed_workspaces: [creating_workspace]` on create is the recommended fix.
- **B4 — CreateAgentDialog doesn't auto-populate `allowed_workspaces`.**
  Pairs with B3.
- **B5 — Select primitive showed placeholder after selection.** Fixed
  (`a835654`).
- **B6 — `missing_prompts` warnings for stages the runner doesn't own.**
  The runner scopes owned stages to its team_roles now
  (`loop.go:149-169`); frontend toasts should follow.
- **B7 — hardcoded Go fallbacks for unauthored stages.** For the five platform
  stages, Go still has baked-in prompts (`prompts.go`, `prompts_reviewer.go`,
  `prompts_documentator.go`, `prompts_research_plan.go`). The
  "platform-authority drops the role" code (`loop.go:302-343`) is the forward
  direction; the compiled-in templates are maintenance liability per
  `feedback_backend_authoritative_config.md`.
- **B8 — exported YAML writes a `role:` field the runner ignores.** Purely
  cosmetic; misleading. Tracked against the agent export endpoint.
- **B9 — exported YAML's `git.base_dir` is a `/path/to/repos` placeholder.**
  For runners whose roles don't use git (secretary/planner kinds), the field
  is irrelevant but required-looking.
- **B10 — `mcp_config_path` is operator-visible and meaningless to humans.**
  The preferred fix is the two-file export bundle:
  `intern-{name}.yaml` + `mcp-config-{name}.json` pre-baked.
- **B11 — custom `produces_note` prompt did not trigger the note tool.**
  Addressed at the prompt-synthesis layer: `_POST_PROCESS_IMPERATIVES` at
  `prompt_defaults.py:715-738` now splices the `create_note` imperative into
  synthesized prompts when `post_process_kind=produces_note`. Runners prefer
  `resolved_content` over `content` so operator edits on synthesized
  placeholders retain the imperative (`types.go:120-128`).

### From the Go audit (selected highlights)

- **Hardcoded column-type fallbacks.** `loop.go:1350` (`ship` → "review"),
  `loop.go:1377` (`reworkShip` → "review"), `strategy_generic.go:246`
  (rework merged-PR shortcut → "done"), `strategy_generic.go:1483`
  (failWithConfig → "backlog"), `strategy_generic.go:1494`
  (circuit-breaker → "blocked"). All are platform-authority principle
  violations, queued for cleanup (Batch D).
- **Role propagation lost.** `LogExecutionStart(..., role="orchestrator")`
  is literally hardcoded at `loop.go:914` and `loop.go:1091` — every
  hero-path execution records `role="orchestrator"` even when a custom
  researcher or planner drove it. Queued as Batch B.
- **`DefaultPipelineConfig` still compiles into the binary.**
  `pipeline_config.go:8-147` is dead on the runtime hot path (Loop.New
  refuses to start without a platform pipeline) but `config_validate.go:124,145`
  still references it — so validation output can disagree with runtime
  behavior. Queued as Batch C.
- **`gh`-ism outside `git/`.** `harness/sensor_pr_overlap.go:216-241` shells
  out to `gh pr list` from the `harness/` package. Queued as Batch E to move
  behind `git.Manager`.
- **stream-json edge cases.** `claude_cli.go` guards against partial
  StructuredOutput on non-zero exit (line 140) but `stream.go:96-102` still
  returns raw stdout on parse failure. Stderr tail is capped at 64KiB
  (`claude_cli.go:15-47`).

### Platform-authority violations inventory

From `audit_intern_go.md` "Hardcoded runtime fallbacks (full inventory)":
- `config.go:155-163` — Git defaults leak across workspaces (branch_prefix
  "intern/", auto_pr true, auto_merge true, squash, etc.).
- `loop.go:100-103` — runner-side defaults for `max_rework_attempts`,
  `card_cooldown_hours`, `commit_message_template`. Platform value should
  always win; treat non-zero as required.
- `loop.go:504-510` — `failureBackoffDuration` default 5s when platform
  omits `MinFailureBackoffSeconds`.
- `valaris/types.go:229-240` — `LegacyPostProcessKind` stage→kind map
  (back-compat shim; delete once platform always emits `post_process_kind`).
- `strategy_generic.go:1007` — `docs(%s):` commit prefix triggered by
  `BranchPrefix != ""`, an implicit "documentator-ish" detection.

None of these are runtime-fatal. They are all instances where the platform
should be the single source of truth and the Go default provides a shadow
value.

---

## 10. Extensibility story

Per `feedback_extensibility_no_limits.md`: any role with any rules and any
prompts must be user-expressible end-to-end. Defaults are OK; hardcoded
ceilings are bugs.

### What's achieved

- **Arbitrary role names**. `stages[].role` is a free-form string in the
  pipeline schema (`workspace_config.py:21-170`), in the Go runner
  (`types.go:178`), and across the prompt-config scope. The 2026-04-18
  walkthrough defined a `Secretario` role and it ran end-to-end.
- **DSL-level pipeline authoring**. Operators choose discover strategy,
  filters, claim participant role, git action, LLM tools, sensors, branching
  actions — all through pipeline_config JSON. The Go runner's
  `DataDrivenStrategy` is a single generic implementation parameterized by
  the config (`strategy_generic.go:20-30`).
- **Data-driven scheduling**. Priority order comes from the platform;
  `appendMissingRoles` seatbelt covers operator mistakes. Mode is
  round-robin or priority, selected by config.
- **Synthesized placeholder prompts for custom roles**.
  `get_prompt_defaults_with_synthesis(pipeline_config, role_filter)`
  (`prompt_defaults.py:816`) returns registry entries + synthesized minimal
  prompts for any (role, stage) in the config lacking a registry entry. The
  UI "Create new stage" form lines up with synthesized slugs so edits
  materialize as overrides on the same slug.
- **Post-process imperatives for custom prompts**. `_POST_PROCESS_IMPERATIVES`
  (`prompt_defaults.py:715-738`) means a custom `produces_note` /
  `mutates_backlog` / `produces_decision` stage gets the correct MCP-tool
  instruction spliced into the prompt, so operators don't need to know to
  write it.
- **Graceful skip for unauthored stages**. Runner returns
  `status: skipped` instead of falling back to a hardcoded template when the
  stage has no prompt and `UseMinimalPromptWhenUnauthored` is false
  (`strategy_generic.go:185-188`).

### What's still gated

- **Per-role LLM provider/model** — pending (see section 5 and
  `feedback_llm_abstraction_north_star.md`). Today all roles route through
  the single `LLMConfig`; `model_overrides` is phase-keyed, not role-keyed
  (`config.go:80-84`).
- **`agent_type` enum still required on create** — dropped from UI in
  Phase 1 of the rename migration; schema cleanup deferred to Phase 3
  (`vocabulary_runner_migration.md`). MCP tool `create_agent` still
  expects the field.
- **Hardcoded Go fallbacks for the five platform stages**
  (`prompts.go`, etc.). Extensibility not blocked — custom stages are
  handled via synthesis or graceful skip — but these compiled-in templates
  are a maintenance liability and a leaky abstraction.
- **`TeamRole` enum / `PROMPT_STAGE_REGISTRY` Python list** — both encode
  the legacy role set as Python literals. Work to turn these into
  config-driven surfaces is tracked as plan T1.1 in
  `feedback_extensibility_no_limits.md`.
- **Column-type strings are free-form but a few sites still hardcode
  `"review"`, `"done"`, `"backlog"`, `"blocked"` as fallbacks.** See the
  platform-authority violations inventory above. Extensibility is not
  blocked — the custom role will still move to whatever column its
  `ActionDef.MoveToColumnType` points at — but operator mistakes that leave
  the field blank silently land on a legacy default.

### Summary

The data model and the runtime hot path are extensibility-ready: a new role
with custom discover, claim, git, LLM, sensors, and branching action is
expressible through a pipeline_config PATCH plus a prompt-config POST, and
the runner picks it up on the next tick. The rough edges are at the
boundaries — the Go runner's defaulting behavior, the export / MCP surface,
and the half-migrated Python enums — not the engine itself.

---

## Appendix — Key files

Backend:

- `backend/app/models/agents/{agent.py, team.py, prompt_config.py, execution.py}`
- `backend/app/services/agents/{agent.py, team.py, prompt_config.py, prompt_defaults.py, execution.py}`
- `backend/app/services/workspace_config.py` — `DEFAULT_PIPELINE_CONFIG` + config CRUD
- `backend/app/services/pipeline_config_validation.py` — canonicalization + referential checks
- `backend/app/services/approvals/{approval.py, risk.py}`
- `backend/app/services/kanban/card.py` — `claim_card`, `move_card`, participants
- `backend/app/services/git/git_repo.py`
- `backend/app/routers/agents/{agents.py, teams.py, executions.py, prompt_configs.py}`

Runner (Go):

- `intern/cmd/intern/main.go` — bootstrap, signal handling, banner
- `intern/internal/config/config.go` — YAML shape + defaults + env overrides
- `intern/internal/valaris/{client.go, types.go}` — REST client + wire types
- `intern/internal/workloop/loop.go` — `Loop`, heartbeat, prompt cache, platform authority
- `intern/internal/workloop/scheduler.go` — multi-role scheduler
- `intern/internal/workloop/strategy.go` / `strategy_generic.go` — `DataDrivenStrategy`
- `intern/internal/workloop/prompts_minimal.go` — cross-repo synced minimal agentic prompt
- `intern/internal/workloop/prompts*.go` — hardcoded prompt fallbacks for legacy 3-role set
- `intern/internal/git/git.go` — git/gh operations
- `intern/internal/events/client.go` — WS client
- `intern/internal/llm/{claude_cli.go, stream.go}` — LLM provider + stream-json parsing
- `intern/internal/harness/` — sensor registry, conflict/gotest/PR-overlap sensors

Cross-repo sync guards:

- `intern/internal/workloop/prompts_minimal_sync_test.go` guards
  `minimalAgenticPromptTemplate` against drift with
  `backend/app/services/agents/prompt_defaults.py:MINIMAL_AGENTIC_PROMPT_TEMPLATE`.
- `backend/tests/test_pipeline_config_shape.py` (and the Go
  `platform_authority_test.go`) pin the `pipeline_config` schema across both
  sides.

*End of note. Live code should always be the authority — this document is a
reading aid, not a spec.*
