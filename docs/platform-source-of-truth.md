# Backplane Platform — Historical Synthesis

> **Status: Superseded and non-authoritative (2026-08-16).** This synthesis is
> retained as design history and is not maintained as the current product
> contract. Use the in-app `/documentation` corpus, `README.md`,
> `docs/loop-mode-contract.md`, `docs/git-credentials.md`, the generated OpenAPI,
> and the implementation for current behavior. When this file disagrees, do not
> copy or translate its claim.

**Last synthesized:** 2026-04-19 from five parallel research reports.
**Audience:** Product stakeholders, new engineers, operators, and any agent producing documentation or UI that claims to explain the platform.
**Tone:** Honest but softened for a broad audience. Technical where it needs to be. No bullshit — but no bug catalogs either.

This document is the reference other documentation, tooltips, and the `/documentation` page will be built from. When this document and the code disagree, the code wins and this document gets updated.

Five companion research reports in [docs/research/](research/) hold the detailed, file-referenced source material:

- [backend-architecture.md](research/backend-architecture.md) — backend layers, data model, auth, events, migrations
- [frontend-ux.md](research/frontend-ux.md) — page inventory, feature modules, kanban UX, pipeline builder, shared UI
- [runner-pipeline-internals.md](research/runner-pipeline-internals.md) — runner lifecycle, agent teams, roles, pipelines, prompts, git
- [mcp-server.md](research/mcp-server.md) — MCP tool catalog, prompts, transport, drift guards
- [history-and-lessons.md](research/history-and-lessons.md) — platform story, principles, rough edges, scoping decisions

---

## Table of Contents

1. [What Backplane Is](#1-what-backplane-is)
2. [Core Concepts](#2-core-concepts)
3. [How It's Built](#3-how-its-built)
4. [What the Platform Does](#4-what-the-platform-does)
5. [Git Capabilities](#5-git-capabilities)
6. [The MCP Surface](#6-the-mcp-surface)
7. [Patterns That Make It Tick](#7-patterns-that-make-it-tick)
8. [Design Principles](#8-design-principles)
9. [Strengths](#9-strengths)
10. [Limitations](#10-limitations)
11. [Deployment & Ops](#11-deployment--ops)
12. [Glossary](#12-glossary)

---

## 1. What Backplane Is

Backplane is an **agentic software factory**: a platform where credentialed runners pick up kanban cards, execute configurable multi-role pipelines against them (implement, review, document, or any custom role an operator defines), interact with git repositories, and report back to a human operator watching live.

Humans shape the system — they define pipelines, author prompts, set budgets, approve risky actions. Runners do the implementation work inside sandboxed branches. The platform arbitrates between them: it stores the canonical pipeline shape, moves cards through columns, records every execution and its cost, coordinates approvals, and broadcasts everything to observers in real time.

### What makes it different from a conventional project-management tool

A conventional kanban app is built for human users who occasionally refresh the page. Backplane is built for a world where the primary operators are LLMs that:

- Retry on any error (so every create/add operation must be idempotent, returning the existing entity instead of 409).
- Work concurrently across pipeline stages (so every mutation must broadcast, and every reader must stay in sync).
- Read fields by name from tool responses (so schemas and docstrings are part of the contract, and drift between surfaces is a real bug).
- Pay for every token (so composite endpoints beat chatty round-trips).

These properties reshape every layer. The idempotency rule makes multi-runner operation possible without custom retry logic. The WebSocket-first event bus makes cross-surface state coherent without polling. The composite MCP tools (like `get_project_context`) collapse what would be five API calls into one. None of these are optional extras — they're the invariants that let the platform scale beyond a single operator manually triaging every runner's output.

### What the platform is NOT

- **Not autonomous.** Runners execute pipelines the operator has configured; they don't invent their own objectives, and they stop at approval gates the operator defines.
- **Not general-purpose.** It's built for software-engineering work — implement / review / document cycles over a git repository. Other domains would need custom pipelines and custom tools, but the primitives (kanban + roles + prompts + approvals) are adaptable.
- **Not model-locked.** Today most stages route through Claude via the `claude` CLI subprocess. Per-role provider/model configuration (Sonnet for implement, GPT-5 for review, Gemini for docs — from the same runner) is the declared north star; the scoping exists, the plumbing is partial.
- **Not a replacement for developer judgement.** Approval gates, review cycles, and the human-authored pipeline config are where judgement lives. The runner executes; the operator decides what executing looks like.

---

## 2. Core Concepts

Five concepts repeat everywhere. Getting them right unlocks the rest of the platform.

### 2.1 Workspace

The top-level tenancy unit. Contains boards, members, channels, teams, pipeline config, budgets, API keys, approvals, and activity history. Identified by a URL slug (`/{slug}/...`). Every feature endpoint lives under `/api/workspaces/{slug}/...` and goes through a single `get_workspace` dependency that resolves the slug, verifies membership, and optionally enforces an admin/owner role.

Members have one of four roles: `owner > admin > member > viewer`. Users are auto-provisioned on first authenticated request — there's no registration flow.

### 2.2 Board, Column, Card

A **board** is a kanban project. Each board owns an ordered list of **columns** (fractional-indexed `FLOAT` positions, not integer order). Each column owns an ordered list of **cards** (same fractional indexing).

Columns carry a `column_type` (`backlog`, `active`, `review`, `done`, `blocked`) that is load-bearing — pipeline stages reference the *type*, not the name, so "Review" and "Peer Review" behave identically if they share the type. Column names are human-facing; column types are the semantic identity.

Cards have `card_type` (`task | bug | feature | issue`), `priority`, `labels: string[]`, `status`, `due_date`, a rich-text description, and a set of **participants**. A participant is a user or runner associated with the card, in one of four roles: `hero` (primary executor), `helper`, `viewer`, `stakeholder`. One hero per card is the convention (enforced in the claim service, not by a DB constraint).

Seven board tabs: kanban, definitions, resources, notes, history, git, alerts. Each tab is a separate page under the same board layout.

### 2.3 Runner (formerly "Agent")

A **Runner** is a credentialed long-running process that an operator launches on their own machine. It:

1. Logs into the Backplane backend with an API key (`Authorization: Bearer vlr_...`).
2. Fetches its platform-authored configuration (pipeline shape, role assignments, prompts, budget) from `/api/agents/me/config`.
3. Loops: poll → claim a card → execute one or more LLM roles → ship → repeat.

One API key = one runner = one OS process. The runner is the Go binary at `runner/cmd/backplane-runner/main.go`, distributed as source (operators run `go build` or use the bundled Dockerfile).

> **Honest remark** — The database, API routes, Go structs, and MCP tools all still say "agent" (`Agent` model, `/api/agents/...`, `create_agent`). "Runner" is the user-facing rename; the schema rename is explicitly out of scope because breaking every integration for a cosmetic win isn't worth it. Phase 1 (UI copy) landed 2026-04-18 and Phase 2 (docs + MCP descriptions) followed; Phase 3 (two-deploy schema cleanup) remains scheduled.

The **backend is the source of truth for pipeline shape and prompts.** The runner refuses to start if the platform hasn't authored a pipeline. This is not a quirk — it's a hard-won principle (see §8). The runner does not carry a compiled-in default pipeline at runtime.

### 2.4 Agent Team & Roles

A **team** is the membership graph that says "these runners play these roles in this workspace." Each team lives in a workspace (optionally scoped to a board). Each member is one runner mapped to a list of **role** strings (free-form; not an enum).

A **role** is a pipeline persona — `orchestrator`, `reviewer`, `documentator`, `researcher`, `planner` are the five platform-shipped defaults, but operators can declare any role they want in `pipeline_config.stages[*].role`. The walkthrough on 2026-04-18 confirmed a custom `Secretario` role running end-to-end without any code change.

Roles are declared unique or not. Platform defaults (`orchestrator`, `reviewer`, `documentator`) default to unique-per-team; custom roles default to non-unique unless the operator sets the flag. The uniqueness enforcement lives in the team service, driven by `pipeline_config.stages[].unique`.

> **Honest remark** — One runner is exposed as belonging to one team in the UI today, even though the data model supports multiple. The simplification will lift when multi-team runners become a real use case.

### 2.5 Pipeline

A **pipeline** is one `pipeline_config` dict on the workspace. It declares:

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
  role: str,                   # free-form — any role
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

A stage is a role + a discover strategy (how does it find its next card?) + a claim definition + optional git setup + optional LLM prompt + optional sensors + post-execution actions (move card, wake another role, add label, create a note, append to definition, etc.).

Multiple stages can exist for the same role — e.g., `orchestrator` owns `implement`, `implement_after_approval`, `mediate_rework`, and `rework_implement`. The scheduler picks one stage per tick based on mode:

- `priority` — iterate `priority_order` left-to-right, pick the first stage that has work.
- `round_robin` — rotate through `priority_order`, skipping stages on cooldown.

### 2.6 Prompt

A **prompt** is the LLM instruction for a specific `(role, stage)` combination, optionally per-team. Prompts live in three layers on the backend:

1. **Registry** — hand-written platform defaults for the 21 known (role, stage) pairs covering the five shipped roles.
2. **Synthesis** — for any (role, stage) in the pipeline that isn't in the registry, a minimal placeholder is generated so the UI always has something to author against. Custom roles are never second-class.
3. **Overrides** — operator-authored `AgentPromptConfig` rows scoped to `(workspace, team, role, stage, slug)`.

The backend also splices a **post-process imperative** into the prompt based on the stage's `post_process_kind` (`writes_code`, `produces_note`, `produces_decision`, `mutates_backlog`). Operators pick the kind from a dropdown; the platform injects the correct tool-call instruction. This is the single most operator-valuable design choice — the operator never has to know to write "Step N: Call `create_note(...)`" by hand.

Runners prefer the backend-assembled `resolved_content` over the raw `content`, so edits on synthesized placeholders retain the imperative.

### 2.7 Approval

A gate inserted by a pipeline stage for destructive or high-risk operations (deletion, bulk change, deployment, schema change, permission change, external action). Flow:

1. The LLM emits `request_approval(category, action_description, payload)` via MCP.
2. The backend computes a risk score; below the `AUTO_APPROVE_THRESHOLD` it auto-approves; otherwise status becomes `pending` and an `approval.created` event publishes.
3. The human sees the pending approval in the UI, decides approve or reject.
4. The runner (subscribed via WebSocket) wakes on the decision and continues the stage via the `implement_after_approval` path.

Approvals expire after 24h by default.

---

## 3. How It's Built

Four collaborating surfaces, one monorepo.

### 3.1 Backend — FastAPI + async SQLAlchemy + Postgres 16

Entry: `backend/app/main.py`. Pattern: **Router → Service → Repository → Model**, enforced culturally (sampled across ~15 feature modules, no direct router-to-repository calls).

- **Router** — thin. Parses the request, wires dependencies (workspace resolution, auth), calls one service method, returns a Pydantic schema. Authorization happens implicitly via `get_workspace` / `get_workspace_admin` dependencies.
- **Service** — business logic, cross-repository orchestration, idempotency enforcement, activity recording, event publishing. Every mutation calls `ActivityService.record(...)`.
- **Repository** — pure data access. `BaseRepository` provides `get_by_id / list / count / create / update / delete` over a generic model. Uses `selectinload` whenever the response schema has nested relationships; models default to `lazy="raise"` as a guardrail against accidental N+1 in async contexts.
- **Model** — SQLAlchemy 2.x declarative. Every model has a UUID primary key (`gen_random_uuid()` server default) and `created_at` / `updated_at` timestamps.

**Layered authentication** lives in `backend/app/core/auth.py`, evaluated in this order:

1. API key (`Authorization: Bearer vlr_...`) — preferred for runners and MCP callers and may bind a linked runner identity.
2. Session cookie — minted by local password login or the OIDC callback when local authentication is enabled.
3. Dev mode (local development only) — trusts `X-User-Email`, defaulting to `dev@valaris.dev`.
4. IAP — validates the `X-Goog-IAP-JWT-Assertion` ES256 JWT when `IAP_AUDIENCE` is configured.
5. Trusted proxy — accepts the authenticated-user header only when `TRUSTED_PROXY_AUTH` is enabled and the request carries the matching proxy secret.

If no verifier is configured, the request fails with 403. Header-tier users are auto-provisioned on first request; cookie users are not.

**Migrations** are sequential three-digit Alembic revisions (see `backend/alembic/versions/` for the current head), running on container startup. Cloud Run does rolling updates, so old and new code briefly coexist against the new schema — the discipline is: additive columns with `nullable=True` or `server_default`, two-deploy column removal, never rename.

### 3.2 Frontend — React 19 + TypeScript + Vite 6

Stack: React Query (all server state), React Router, Tailwind v4 (CSS-first, no `tailwind.config.js`), shadcn/ui (hand-written in `src/components/ui/`, not CLI-installed), dnd-kit, react-i18next, Sonner, Recharts, Tiptap, GSAP.

**Feature modules** live in `src/features/{name}/` with the canonical split:

```
features/{name}/
├── api/           # React Query hooks (queries + mutations)
├── components/    # Presentational + container components
├── hooks/         # Local feature hooks (UI state, derived selectors)
└── utils/         # Pure helpers (formatters, validators)
```

21 modules: activity, agents (biggest — includes the pipeline-builder subtree), alerts, approvals, auth, channels, dashboard, definitions, git, integrations, kanban, members, mentions, notes, notifications, observer, resources, settings, timeline, visuals, workspaces.

**Shell chrome** — `AppShell` renders `Sidebar` + `TopBar` + page outlet + a floating `ObserverPanel` (admin-only, draggable, streams WS events in four namespaces). Routes declared in one place: `src/App.tsx`.

**State and data** — all remote data flows through React Query v5 with query keys defined per-domain in `src/lib/query-keys.ts`. No Redux, no Zustand for server state. Optimistic updates are the default for user-visible mutations (card move, card create, column reorder) with snapshot-and-rollback.

**WebSocket integration** — one `WebSocketService` per workspace slug, backed by a `WebSocketProvider`. A `serviceEpoch` counter solves the child-effect-before-parent-effect timing problem that would otherwise make `useWebSocketEvent` consumers subscribe against a null service ref. The `useDomainSync(domain, queryKey)` hook is the one-line WS → cache invalidation bridge, adopted throughout the feature hooks (30+ callsites).

### 3.3 Runner Go Client — the Runner

Single static Go binary at `runner/cmd/backplane-runner/main.go`. Stdlib-heavy (no large framework), `slog` for structured logging, `gorilla/websocket` for WS, `go-yaml` for config parsing, `exec.CommandContext` for Claude CLI subprocess management.

One runner = one OS process = one API key. On startup:

1. Loads YAML config, authenticates against the backend, resolves its identity.
2. Fetches the platform pipeline via `GET /api/agents/me/config`. **Refuses to start** if no pipeline or no stages are returned.
3. Opens a WebSocket connection subscribing to `card.*`, `approval.*`, `execution.*`, `config.*`, `agent.*`.
4. Enters the work loop: heartbeat → refresh prompt cache → re-apply platform authority → `tick()`.

Each tick spawns a `claude -p` subprocess per stage. The subprocess inherits an MCP config pointing at a local MCP server instance, which proxies back to the Backplane backend.

On SIGINT/SIGTERM, the runner drains up to 60 seconds before rootCtx cancels. Second signal forces immediate shutdown.

### 3.4 MCP Server — the Machine-Facing Contract

Python 3.12+, FastMCP (`mcp[cli]`), `httpx.AsyncClient` against the backend. Transports: stdio by default; switchable to streamable-http via `MCP_TRANSPORT`.

**Tools** — the full census is drift-guarded in CI by `backend/tests/test_mcp_catalog_drift.py` (read the current count from there or from `get_server_info`) — spanning workspaces, boards, columns, cards, bulk/composite, notes, resources, channels, git repos, definitions, activity, agents, teams, prompt configs, approvals, webhooks, and more. Plus **10 prompts** (role-based workflows: init_project, standup, triage, status, plan_work, decompose_card, sprint, pickup, implement, ship) and **3 resources** (workspace URIs).

All tools share a shape: `async def tool(...kwargs, ctx) -> str`, decorated with `@mcp.tool()` over `@handle_api_errors`, returning `json.dumps(result)`. Most include an `_hint` field that steers the LLM's next action.

**Auth dispatch** in the MCP client picks one of three modes:

1. API key (`VALARIS_API_KEY=vlr_...`) — simplest; preferred for end users.
2. Dev mode — sends `X-User-Email` + `X-Goog-Authenticated-User-Email` set to `VALARIS_AGENT_EMAIL`.
3. IAP mode — uses Google ADC to mint OIDC tokens for the configured `VALARIS_IAP_AUDIENCE`.

**Execution tracking** is installed once per tool manager (`install_tracking`, same shape as `install_hand`) and resolves the calling session's tracker per request, so streamable-http sessions do not stack wrappers. Each tracked tool call that carries a `workspace_slug` opens its own `mcp_session` execution row on `before_tool_call` and finalizes it on `after_tool_call`: status, `cards_affected` and `result_summary` are derived from the tool's text payload after unwrapping FastMCP's converted result (the house error JSON → `failed`; a raised call → `failed` with the exception text as `error_message`). Three tools are tracking-exempt (`log_execution_start`, `log_execution_update`, `get_agent_config`) because the runner manages those rows explicitly.

A drift guard lives in the backend test suite: `backend/tests/test_mcp_catalog_drift.py` AST-parses every `mcp-server/src/valaris_mcp/tools/*.py` for `@mcp.tool()` decorators and compares against the frontend's `VALARIS_MCP_NAMES` array — any rename/add/remove fails CI until the frontend is updated.

---

## 4. What the Platform Does

A functionality tour organized by "what a user observes" with "what happens internally" called out alongside.

### 4.1 Create and Configure a Workspace

**User sees:** `/` landing page with a workspace picker. "Create workspace" dialog prompts for name + slug. First workspace comes with a `FirstRunPanel` on the dashboard walking through initial setup.

**Internally:** `POST /api/workspaces` goes through `WorkspaceService.create_workspace` — on slug collision, idempotent only for members of the existing workspace (they get it back unchanged); a non-member gets an opaque 409 that carries no workspace metadata. Auto-provisions the creator as the owner. Fires an `activity.workspace.created` event.

### 4.2 Create Boards, Columns, Cards

**User sees:** `/{slug}/boards` board directory → create board dialog → redirect to the new board's kanban view → "Add column" button → "Add card" per column. Drag-and-drop to reorder. Click a card for the right-side detail sheet with description, participants, labels, priority, due date, linked notes, stuck-reason panel.

**Internally:** Board detail is a single eager-loaded query — columns and cards come back in one request via `selectinload`. No waterfalls. Card moves compute the midpoint between neighbor positions on the client (fractional indexing math lives in `features/kanban/utils/position.ts`); the backend just persists the float. Moves fire an optimistic cache update that rolls back on server error; the WebSocket event handler on the same cache key re-confirms the commit.

Claim is atomic: `CardService.claim_card` issues a `SELECT ... FOR UPDATE`, refuses the claim if a hero already exists (409 `already_claimed`), and moves the card into the "In Progress" column when one exists.

### 4.3 Define the Board, Attach Resources, Write Notes

**User sees:** Board tabs — `definitions` (rich-text project spec, structured fields for objectives, exclusions, milestones, tech_stack, stakeholders, constraints, decisions, references), `resources` (file/link library, GCS-backed uploads with signed URLs), `notes` (rich-text, supports card-linked notes, pinnable).

**Internally:** All three share the workspace + nullable-board-id shared-scope pattern: a row with `board_id=NULL` is workspace-wide, a row with `board_id=X` is board-scoped. The same service handles both.

### 4.4 Configure the Pipeline

**User sees:** `/{slug}/agents/pipeline` — the Pipeline Builder. Admin-gated. Each stage is a draggable card with collapsible sections for role, discover strategy, column scope, filters, claim, git action, LLM stage + tools + post-process kind, sensors, on-success and on-failure actions. Rich tooltips everywhere (the Strategy field's tooltip is the showcase — `ui.tooltips.pipelineDiscoverStrategy` with rows, callouts, code block, examples, sections, and a link into the Role Glossary).

**Internally:** The page is the most complex in the app. Remote state: `useWorkspaceConfig(slug)` returns `{pipeline_config, version}`. Local state: `DraftPipelineConfig`, deep-cloned with synthesized `_dndId` on each stage so role renames don't break dnd-kit keys. Validation runs client-side every keystroke; server returns structured errors on save.

**Optimistic concurrency:** saves include `expected_version`. A 409 with `{code: "stale_version", current_version, expected_version}` opens the `PipelineDriftDialog` offering Reload (discard local) or Override (force-save). Post-save, the server response re-seeds the draft because the backend canonicalizes — e.g., `scheduling.priority_order` is auto-extended with any stage roles the operator omitted.

**Export:** downloads the canonical pipeline as JSON — the file an operator ships to another workspace.

### 4.5 Author Prompts

**User sees:** `/{slug}/agents/prompts` — role tabs driven by the live pipeline (not a fixed list), per-role stage list. Platform defaults are shown and overridable. Deep-linkable — `?role=reviewer&stage=implement` prefills the create dialog. Editor is a plain textarea today.

**Internally:** `usePromptDefaults` returns the synthesized + registry defaults; `usePromptConfigs` returns per-workspace overrides. `PromptConfig` rows are scoped `(workspace_id, team_id, team_role, stage, slug)` — the slug column is the "friendly ID" for a prompt, unique within the scope tuple. Creates are idempotent on the full scope.

When the runner fetches prompts, it prefers `resolved_content` (backend-assembled with the post-process imperative spliced in) over raw `content`. This closes the "custom `produces_note` role didn't call `create_note`" bug from the runner-launch walkthrough — operators edit the body, the imperative stays spliced.

> **Honest remark** — The prompt authoring UX is one of the areas operators have flagged most often. Today it's a single textarea with no syntax highlight, no variable lint, no live preview, no template inheritance visualization. The MCP server is the path of least resistance for authoring today, not the UI. This is tracked and on the backlog.

### 4.6 Register a Runner, Assign to a Team, Launch

**User sees:** `/{slug}/runner` Runner Console — tabs Overview, Pipeline, Runners, Activity. Overview carries the KPI strip (total runners, success rate, avg duration, total tokens), execution timeline, velocity/quality/cost/improvement panels, pending approvals, team panel, analytics dashboard. From the Runners (or Pipeline) tab an admin clicks "Create runner", which opens the **Launch runner wizard**: Identity (name + optional description; the workspace is bound automatically, budget and rate limit take defaults) → Roles (roles the runner may claim; the wizard adds it to the workspace team, creating "Default runners" if none exists) → Config (downloads `runner-{name}.yaml` + `mcp-config-{name}.json`, keyless — they carry a `${VALARIS_API_KEY}` placeholder) → Launch (copyable command using the env var). The API key is displayed exactly once, at Identity; recovery is rotation from the runner's Advanced settings, not delete-and-recreate. Operator drops the bundle on their machine and runs the Go binary.

**Internally:** `Agent` row is created — idempotent on `(owner, name)`, reactivates soft-deleted runners. API key is minted and its prefix is stored (hashed-at-rest). The runner boots, calls `GET /api/me` then `GET /api/agents/me`, fetches platform config, opens WS, enters the loop.

### 4.7 Observe Live Work

**User sees:**
- Kanban board: an `AgentStatusBar` above the columns showing in-flight executions; cards carry runner badges ("runner active / eligible / touched / awaiting prompt") with rich tooltips.
- Floating `ObserverPanel` (admin-only, draggable, persisted position): streams WS events in four namespaces (card, agent, execution, approval) with pause/resume and filters.
- `ConnectionStatusIndicator` in the TopBar: green / amber-pulsing / red dot, translated tooltip.
- Execution detail page: status, duration, token and cost breakdown, tool invocation list, insights panel.

**Internally:** Every mutation on every entity publishes `activity.{entity}.{action}` on the in-process `EventBus`. The WebSocket router translates those into outbound frames for every connection that subscribed to matching patterns (subscriptions use `fnmatch` — `activity.card.*`, `activity.*.deleted`, `*`). A separate `WebhookSubscriber` drains the same bus for outbound HTTP fan-out.

Service-specific events not activity-shaped — `execution.started / completed`, `approval.created / updated`, `agent.status_changed / heartbeat_received / poll_requested`, `config.changed`, `cost.threshold_crossed` — are published directly from their owning services.

### 4.8 Approve or Reject Runner Actions

**User sees:** `/{slug}/approvals` queue page (sidebar badge shows unread count). Each row: category, risk score, runner, board, payload, created timestamp. Decide approve or reject.

**Internally:** The runner is WS-subscribed to its pending approvals. On decide, the backend publishes `approval.updated`; the runner wakes immediately (no HTTP polling) and re-enters the stage via `implement_after_approval`. Approvals auto-expire after 24h.

### 4.9 Track Cost and Budget

**User sees:** `BudgetPanel` on the runner overview showing total spend, period reset, budget status. Cost alerts when thresholds cross.

**Internally:** Every `AgentExecution` records `cost_usd`, tokens, duration. Budget enforcement is pre-tick: a runner's effective budget is read before claim; if exceeded, the claim is refused.

### 4.10 Analyze History

**User sees:** `/{slug}/history` (workspace-wide), board tab `history` (board-scoped). Filterable activity feed with per-action icons.

**Internally:** `Activity` rows carry `workspace_id`, `entity_type`, `entity_id`, `action`, optional `board_id` and `agent_id`, `actor_id`, free-form `summary` and `changes` JSON. Indexed on `(workspace_id, created_at)`, `(board_id, created_at)`, `(entity_type, entity_id)`, plus actor and agent.

---

## 5. Git Capabilities

### 5.1 Git repositories as first-class entities

A `GitRepo` binds a git URL to a board. Fields: `url`, `provider` (github | gitlab | bitbucket | other), `default_branch`, `slug` (unique per board), `require_branch_protection`. Board tab `/git` lists repos with create/update/delete. Runners use these when setting up work for a card on the associated board.

### 5.2 What the runner does with git

The Go `git.Manager` owns git operations directly — deliberately not delegated to the LLM because git state management needs deterministic control. Implemented operations:

| Operation | Purpose |
|---|---|
| CloneOrOpen | Clone or fetch the repo locally |
| FetchAndResetDefault | Hard-reset default branch to origin |
| CreateBranch | Branch off fresh default, recover on collision |
| CheckoutBranch | Switch to a PR branch (for reviewer) |
| HasChanges / CommitAll | Stage + commit all changes |
| Push / ForceWithLeasePush | Push; rework uses `--force-with-lease` |
| ResetToDefault / Cleanup | Return repo to clean default-branch state |
| CreatePR | `gh pr create`; returns existing URL on duplicate |
| SquashOnto | Collapse branch into one commit on base |
| EnsureBranchProtection | Apply branch-protection via `gh api` |
| EnsureAutoMergeEnabled | Flip repo `allow_auto_merge=true` |
| EnableAutoMerge / MergePR | Arm or directly merge a PR |

**Safety:** force-push refuses to touch `main` or `master`, and refuses any branch that doesn't carry the configured branch prefix.

### 5.3 Review mode

`GitConfig.ReviewMode` chooses:

- **`platform`** (default, single-identity installs) — the reviewer posts verdicts as comments and review notes back into Backplane. Cannot self-approve a PR because the runner is also the PR author.
- **`github`** — a formal `gh pr review` requires a second identity (e.g., a GitHub App). Not the default.

### 5.4 Merge trigger

`GitConfig.MergeTrigger` is either `on_ship` (orchestrator arms auto-merge when it ships) or `on_approve` (wait for reviewer approval). Both paths flow through `EnableAutoMerge` — GitHub handles the actual merge when required status checks pass.

### 5.5 What's NOT implemented

- **No repo scaffolding** or template-clone from a runner. Board-repo linkage is manual via the UI or MCP.
- **No non-GitHub auto-merge** today (branch protection and auto-merge arming use `gh api`).
- **No WebUI-driven merge** — merge happens via GitHub's own auto-merge or via `gh pr merge` shelled by the runner.
- **Git host provider abstraction** (GitHub / GitLab / generic-webhook) is on the backlog as `T1.4`.

---

## 6. The MCP Surface

### 6.1 What MCP is and why it matters

The **Model Context Protocol** is an Anthropic-led protocol that lets an LLM host (Claude Code, Claude Desktop, Cursor, Codex CLI, custom runners) discover and call external tools, read resources, and expand server-authored prompts. Each MCP server declares a capability surface; the host negotiates it at startup and exposes tool handles to the model.

The Backplane MCP server wraps the backend REST API and exposes platform operations as MCP tools. It is **the single cross-LLM integration point**: whatever a caller wants to do programmatically against Backplane — list cards, claim one, move it, create a note, request approval — it does via an MCP tool call.

Callers include Claude Code running on a developer laptop, the Go runner (which spawns Claude CLI with `--allowedTools` pointing at the MCP server), and operators invoking workflow prompts (`/init-project`, `/standup`, `/pickup`).

### 6.2 Tool categories at a glance

The MCP catalog has continued to grow since this historical snapshot. Derive
the current tool count from the registered decorators or `get_server_info`
rather than freezing the number in documentation. The former 102-tool inventory
below is retained only to explain the April 2026 design:

- **Workspaces** (8) — list, get, summary, create, config, add/remove member
- **Boards** (9) — list, get, create, update, delete, freeze/unfreeze, loop config
- **Columns** (4) — create, update, delete, reorder
- **Cards** (10) — CRUD plus move, claim, add/remove participant
- **Card dependencies** (7) — add/remove/list, bulk set, status, validate
- **Bulk / Composite** (5) — `bulk_create_cards`, `search_cards`, `get_project_context`, `get_board_health`, `next_assignment` (the runner pickup path)
- **Notes** (5), **Resources** (7), **Channels** (4), **Git Repos** (4), **Definitions** (2), **Activity** (1)
- **Runners** (8) — lifecycle, execution logging, config fetch
- **Merge Queue** (4), **Teams** (7), **Prompt Configs** (5), **Workspace Config** (5)
- **Approvals** (4), **Webhooks** (2), **Server info** (1)

The composite tools are the ones to know about. `get_project_context` returns definition + board summary + notes + git repos + recent activity in one call — recommended first call for any workflow. `bulk_create_cards` creates up to 50 cards in one POST. `get_board_health` returns health score, stale/overdue/unassigned counts, and velocity.

### 6.3 Workflow prompts

Ten role-based prompts that inject phased workflows into the conversation:

| Prompt | Role | What it does |
|---|---|---|
| `init_project` | Initializer | Bootstrap: UNDERSTAND → DESIGN → BUILD → VERIFY |
| `standup`, `triage`, `status` | Secretary | Daily note, health check, cross-board summary |
| `plan_work`, `decompose_card`, `sprint` | Architect | Decompose objective, split card, sprint selection |
| `pickup`, `implement`, `ship` | Coder | Claim, implement with TDD, move to Done |

Mutation-producing prompts (standup, triage, plan_work, sprint) gate destructive phases behind explicit user confirmation.

### 6.4 Frontend MCP config page

`/{slug}/settings` — the **Platform Settings** page — is where an operator wires a coding agent to the platform. Four cards:

1. **MCP Server install instructions** — copy-pasteable `uvx --from "git+...#subdirectory=mcp-server" valaris-mcp` and pip equivalent.
2. **Agent Workflows** — static grid of the 10 prompts grouped by role (Initializer, Secretary, Architect, Coder).
3. **API Keys** — list, generate, revoke.
4. **MCP Configuration snippet** — JSON block the user drops into Claude Desktop / Claude Code config, with the install command, API URL, and API key pre-filled.

> **Honest remark** — The workflow card uses dashed names (`plan-work`, `init-project`), but the MCP server registers underscore names (`plan_work`, `init_project`). A user clicking the dashed name will not find a matching MCP prompt handle. If Claude Code slash-commands are meant to match, either update the page or add dashed aliases. Cosmetic.

A separate tool catalog — `frontend/src/features/agents/lib/toolCatalog.ts` — hand-maintains `VALARIS_MCP_NAMES` for the Pipeline Builder's tool picker. The drift guard in `backend/tests/test_mcp_catalog_drift.py` fails CI if any `@mcp.tool()` decorator is added, renamed, or removed without updating the catalog.

---

## 7. Patterns That Make It Tick

Four design patterns show up everywhere. Understanding them is half of understanding the platform.

### 7.1 Idempotent Mutations

Create and add operations return the existing entity (200 / 201) instead of raising 409 when the target already exists. This is a **correctness invariant**, not a nicety — LLM retries, multi-role pipeline ticks, and frontend double-clicks all depend on it.

Where applied: workspace create, board create, card create (via slug), add participant, add team member, create team, create prompt config, runner registration.

Where deliberately not applied: claim card (a second claim when a hero exists is a visible race, returns 409), add hero participant when another hero exists, approval decide (re-deciding a non-pending approval is 409).

> **Why this matters:** ST#3 showed a reviewer role getting a 409 on re-adding itself as a participant and wasting a tick per failure. Multiplied across a smoke run, this is dollars. "Already exists" is a success, not an error.

### 7.2 Fractional Indexing

Columns and cards use `FLOAT` positions. A new item gets `max_position + 1024`. Moves compute the midpoint between neighbors. The result: no O(N) reorder updates, no index rebuilds, no race conditions when two users drag simultaneously. The frontend computes positions; the backend just stores them.

The algorithm is trivially small (six lines in `features/kanban/utils/position.ts`), and the drop detection uses a three-stage fallback (`pointerWithin` → `rectIntersection` → `closestCenter` restricted to columns) to handle multi-column dnd-kit edge cases.

### 7.3 WebSocket-First Communication

If two components on the platform (backend, runner, frontend, MCP) can reach each other through the existing workspace WebSocket bus, they use it. HTTP is reserved for REST RPCs (claim card, move card, PATCH execution), external webhooks (GitHub callbacks), and the MCP tool-call server.

Every frontend query hook that wants live sync gets it via a single line:

```ts
useDomainSync("card", boardKeys.detail(slug, boardId));
```

The runner subscribes to `card.*`, `approval.*`, `execution.*`, `config.*`, `agent.*` and wakes on any matching event, replacing fixed-interval polling. HTTP-poll paths remain only as fallbacks (`enabled: !wsConnected`).

> **Why this matters:** The Poll-Now button used to post from the backend to the runner over HTTP. Docker networking blocked the path. The WS bus already connected them. Beyond that specific incident, every HTTP-poll path is a source of latency floors (frontends polled at 15–120s windows), topology fragility (container-bridge / NAT / VPN failures), and observability blind spots (HTTP traffic doesn't flow through the same event bus everything else does).

> **Honest remark** — WS timing has been the hardest thing to get right. React StrictMode double-mount races, server-side subscribe-timing gaps, and provider/child effect timing have each required a specific mitigation (stale-connection guards on every WS callback; explicit `{subscribe: [...]}` frames on connect; a `serviceEpoch` counter in the provider). These are solved but not forgotten — each new WS consumer multiplies the blast radius of any timing bug.

### 7.4 Platform-Authoritative Configuration

The backend is the single source of truth for pipeline shape and prompts. The Go runner fetches these at startup and refuses to start if the platform hasn't authored them. The runner does not carry a compiled-in default pipeline at runtime.

If an operator authors a role named `security-auditor` via the UI, the runner picks it up on the next poll without a single Go file changing. If the operator removes a role, the scheduler drops it without restart. The platform owns identity and behavior; the runner owns execution.

> **Why this matters:** ST#8 silently shipped a 3-role hardcoded pipeline over a 5-role platform pipeline. The backend was configured correctly; the runner ignored it. The fix isn't "add better defaults" — it's "refuse to operate on stale authority." Defaults and fallbacks are legitimate at the *platform* level; they're a bug at the *client* level.

> **Honest remark** — A handful of residual hardcoded fallbacks survive in the Go runner (column-type strings in failure paths, role literals in execution logging, a compiled-in `DefaultPipelineConfig` reachable only from validation paths). They don't fire on the runtime hot path, but they're maintenance liability — tracked for cleanup under the LLM abstraction milestone because the real fix is model-per-role independence, not patching the heuristic.

---

## 8. Design Principles

These are the durable rules the project enforces. Each came from a concrete incident. Each now governs design review.

- **Backend owns pipeline, role, and prompt configuration.** Client-side fallbacks are a bug. Platform-level defaults are fine.
- **WebSocket-first communication.** HTTP only for REST RPCs and external webhooks.
- **Idempotent mutations.** Create and add operations return the existing entity on duplicate.
- **Code-controlled context augmentation.** Every piece of mandatory context a prompt needs — directives, review history, card context — is fetched by code and injected into the prompt under a clearly-labelled mandatory section. The LLM never fetches its own mandatory context. LLMs treat tool-call results as optional reference.
- **Directive compliance requires imperatives or Opus.** Sonnet reliably ignores subtle directives; fixes are either structured imperative injection or model selection (Opus for stages that must obey fine-grained rules).
- **Extensibility without hardcoded ceilings.** Operators must be able to declare any role, any rules, any prompts end-to-end. Defaults are legitimate; hardcoded ceilings are bugs.
- **Model-agnostic per-role LLM provider.** Role extensibility without model extensibility is a half-answer. Implementer on Sonnet + reviewer on GPT-5 + documentator on Gemini — from the same runner — is the declared target.
- **Review context quality requirements.** Rework prompts need reviewer findings as structured action items, not raw prose. Numbered, file:line-anchored, checkbox-shaped.
- **TDD mandatory for new features.** Write the failing test first, write the minimum code to pass, refactor while green. Integration tests use `httpx.AsyncClient` against the real FastAPI app with in-process aiosqlite. No Docker.

Meta-rules for how work gets done:

- One theme per branch, ~20-commit soft ceiling, PR-before-drift.
- Every sub-agent brief transmits project principles explicitly (sub-agents start with zero context).
- Worktree isolation is not always safe when a fanout depends on pre-landed state.
- Never stop a running agent or test without explicit operator permission.
- No gold-plating, no half-finishing. Three similar lines beat a premature abstraction.

---

## 9. Strengths

What's clearly working after four months of concentrated work on the agentic surface:

- **Monorepo + pnpm workspaces.** Four deployable surfaces (backend, frontend, MCP, runner) live in one repo with one lockfile. Cross-surface refactors happen in one PR with one CI run. Schema drift is a `git diff` away from being visible.
- **Layered backend discipline.** Every authz gap is localizable to a service method, every data-access pattern is reusable, every test can stub at the right layer. The 2026-04-17 audits produced exact file:line references because the layering is consistent enough to navigate.
- **Composite MCP tools.** `get_project_context` collapses five calls into one. `get_board_health` collapses three. `bulk_create_cards` takes up to 50 cards per request. Savings compound over a full pipeline run.
- **Board detail as a single eager-loaded query.** No waterfalls, no tail latency on board renders.
- **Activity bus as both persistence and live feed.** Every mutation on every entity records to the DB *and* publishes on the WebSocket bus under a consistent namespace (`activity.{entity}.{action}`). Debugging multi-runner sequences becomes tractable — "what did runner X do at 14:03?" is a single SQL query.
- **Idempotent create patterns.** Where applied, LLM retries and multi-role pipeline ticks stop costing budget.
- **Strict test discipline.** 319 commits, zero `TODO`/`FIXME`/`XXX`/`HACK` in the tree. Zero production `any`/`ts-ignore` in the frontend. TDD as a non-negotiable.
- **Live smoke tests as validation gate.** No milestone closes on CI alone. An operator walks through end-to-end with real tokens, real Cloud SQL, real runners. Every smoke test has paid for itself in structural bug discovery.
- **React Query uniformity.** One pattern for server state. Query keys defined per-domain. Optimistic updates for user-visible mutations. Predictable drop-in for every new feature.
- **i18n from day one.** Every new user-facing string must live in every catalog registered by `frontend/src/i18n/supported-languages.ts` (currently `en`, `es`, and `pt-BR`); enum values are localized via dynamic keys. CI enforces symmetric keysets and prevents existing hardcoded-copy debt from growing while it is extracted.
- **Event taxonomy documented and versioned.** `docs/events.md` catalogs every live event, its publishers, its subscribers, payload conventions. Adding a new event is a documented 3-step process.
- **Layered authentication with explicit failure modes.** API keys, session cookies, dev headers, IAP JWTs, and trusted-proxy headers are evaluated in a fixed order; an unconfigured deployment fails closed.
- **Scoped test runs.** `make test` (full backend), `make test-fast` (parallel), `cd runner && go test ./...`, `pnpm --filter frontend typecheck`. Sub-agents work on scoped surfaces without stepping on each other.
- **The post-process imperative contract.** Stages declare `post_process_kind`; the backend splices the correct tool-call instruction into the prompt. Operators never have to know to write "Step N: Call `create_note(...)`" by hand. The single most operator-valuable design choice in the history of the project.

---

## 10. Limitations

Honest and softened. None of these are structural; all are addressable. Grouped by theme rather than enumerated as a bug list.

### 10.1 Custom-role authoring UX

The platform accepts custom roles end-to-end — pipeline DSL, scheduler, runner, prompt synthesis. The UI for authoring prompts against custom roles is behind the data model. The prompt editor is a plain textarea. The pipeline builder duplicates backend enum constants in TypeScript (column types, discover strategies, claim roles, git actions, post-process kinds) that silently go out of date when the backend adds a new variant. A `/config/schema` endpoint that the frontend can pull from at runtime is the right fix and is on the backlog.

### 10.2 WebSocket coverage and timing fragility

Post-M-Observability, `useDomainSync` is adopted at 30+ callsites and `activity.{entity}.{action}` events fan out for 31 `(entity, action)` pairs. The structural half is done. Known open items: `AgentStatusBar` still polls `useExecutions(status: "started")` rather than subscribing to `execution.*` directly; a few dead event constants (`board.health_changed`, `agent.heartbeat_received`) are declared but never emitted or consumed; `useConfigSync.ts` subscribes to a `team.*` wildcard the backend doesn't emit (team changes flow through `config.changed`). StrictMode races, subscribe-timing gaps, and provider/child effect timing are each mitigated individually — the mitigations are load-bearing, not decorative.

### 10.3 Runner onboarding friction

The 2026-04-18 walkthrough proved the pipeline executes end-to-end, but three manual interventions were needed that a first-time operator wouldn't know to perform. Most are now fixed — the allowlist visibility wall, the misleading `role:` field in exported YAML, the `git.base_dir` placeholder, the raw `mcp_config_path`, the `produces_note` imperative. The last live smoke (first-time operator reaches "runner is doing useful work" in under 60 seconds of clicks) is pending.

### 10.4 Schema drift across four surfaces

Pydantic schemas (backend), TypeScript interfaces (frontend), Go structs (runner), and JSON payloads (MCP) drift in slow, compounding ways. `Board` and `GitRepo` on the runner side lack `slug` fields. `PlatformConfig` on the runner exposes a single `TeamRole` rather than `team_roles[]`, so multi-role runners effectively see only their first role. `WorkspaceConfig` on frontend omits `model_pricing`. Most of these have 3-line fixes; they add up because each is a separate contract.

### 10.5 Per-role LLM provider/model

The declared north star is per-role `llm.provider` + `llm.model` — implementer on Sonnet, reviewer on GPT-5, documentator on Gemini, all from the same runner. Today the runner has a single `LLMConfig`; `model_overrides` is phase-keyed, not role-keyed. All routes go through `claude-cli`. An internal scoping note (not exported) covers the design; the work is on the backlog as the LLM abstraction milestone. Self-review / same-runner-as-reviewer guards (e.g., the hardcoded `p.Role == "reviewer"` in the Go runner) are pre-abstraction heuristics that will lift with model independence.

### 10.6 Authoring surface rough edges

- Prompt editor is a plain textarea (no syntax, no lint, no preview).
- Dialog state reset hygiene is inconsistent across CreateX dialogs (some reset on close, most don't).
- `alert()` survives in one editor (`RichTextEditorImpl`'s file-too-large path) — breaks IAP iframe styling and test determinism. Tracked.
- `sonner` toast is mounted at root; component test coverage for feature modules is thin (11 of 13 modules have zero component tests).

### 10.7 A few backend edges

- Migrations run on container startup. A slow migration can block rolling Cloud Run revisions coming up.
- Rate limiter is per-instance in-memory; Cloud Run scales to N instances, so effective cap is `N × limit`. Fine for dev, insufficient for real abuse protection. Redis / Cloud Armor migration is on the backlog.
- Event bus is in-process and single-pod; a Cloud Run instance dying mid-handler drops queued callbacks. Acceptable for activity notification, would bite anything financially consequential.
- Bridge events (`card.*`, `column.*`) still publish alongside `activity.*.*` for backward compat. Deprecated; sunset not scheduled.

### 10.8 MCP residuals

- `list_teams` query-params shape is broken (kwargs dict passed as a single `params=` arg). Low-effort fix.
- `create_agent` docstring lists legacy agent_type values (`coding | reviewer | documentator`) that don't match the live enum (`coding | manager | reviewer | secretary | improver`) and include a team_role (`documentator`) that isn't an agent_type.
- `create_workspace` does a pre-GET to detect duplicates — retained deliberately: backend idempotency is member-scoped (non-members get an opaque 409), so the pre-GET is what gives a member the friendly `existing` payload.
- `test_server_loads_all_tools` asserts only a fixed subset of the registered tools — a broken registration on the rest wouldn't fail that test (the CI drift guard checks name parity, not loadability).

### What the audits did NOT find

No `TODO`/`FIXME`/`XXX`/`HACK` markers in the tree. Zero production `any` / `@ts-ignore` / `as any` in the frontend. No `panic()` outside `main` in Go. No manual transaction commits in services. No missing `selectinload` on Pydantic schemas with nested relationships. Discipline at the craftsmanship layer is tight; the debt is at the seams (authz, idempotency, config authority, WS coverage, schema drift) where principle enforcement takes continuous vigilance.

The distinction matters because it tells you what kind of work remains. Craftsmanship debt compounds with every new file — you either clean as you go or accept a rewrite. Principle-enforcement debt localizes — each finding has a fix that touches a few files, a few tests, and closes on its own merit. The audits surfaced ~50 findings. None structural. All addressable.

---

## 11. Deployment & Ops

Concrete production details worth knowing before shipping a change.

- **GCP project**: the production GCP project, region `us-central1`. Cloud Run (backend + frontend) + Cloud SQL Postgres 16 + Cloud Build + GCS.
- **IAP on frontend only.** `IAP_AUDIENCE` = `/projects/<project-number>/locations/us-central1/services/<frontend-service>`. Restricts access to `@valaris.studio` Google Workspace. Backend sits behind the frontend proxy — runners authenticate with API keys, not Google identities.
- **Cloud SQL hosts three databases:** `valaris` (this app), a second unrelated tenant app, and `postgres` (system). Always verify `DATABASE_URL` before running migrations.
- **Automated backups** daily at 04:00 UTC, 7 retained. Point-in-time recovery enabled. The 2026-03-19 DB incident validated the PITR path.
- **Alembic** runs from `backend/`, not the repo root. `cd backend && alembic upgrade head`. URL overridden at runtime from `app.config.settings`.
- **Cloud Build:** Kaniko has no shell — use `gcr.io/cloud-builders/docker` when a step needs env-var interpolation. `$$` escapes bash variables in `cloudbuild.yaml`. `SHORT_SHA` only in trigger builds.
- **Migrations-on-startup:** rolling updates mean old and new code briefly coexist. New columns `nullable=True` or `server_default`. Remove is two deploys (stop reading, then drop). Never rename.
- **Docker frontend node_modules** persists via a named volume (`frontend-node-modules`). CMD runs `pnpm install --prefer-offline`. `ENV CI=true` prevents TTY prompts. First boot slow; every subsequent boot instant.
- **Infra provisioning:** `bash infra/setup.sh` from repo root. Idempotent.
- **Deploy is one command:** `make deploy-backend`, `make deploy-frontend`, or `make deploy`. Artifacts to Artifact Registry, Cloud Run picks up revisions. Rollback: `gcloud run services update-traffic --to-revisions=<previous>=100`.

---

## 12. Glossary

- **Activity** — a row in `activities` recording a mutation. Post-M-Observability, every activity also publishes on the WebSocket bus under `activity.{entity}.{action}`.
- **Approval** — a gate inserted by a pipeline stage. A human (or auto-threshold) must decide before the stage completes.
- **Board** — a kanban project. Owns columns, cards, definitions, resources, notes, git repos, alerts.
- **Card** — a work item on a kanban board. Has title, description, labels, type, priority, participants, due date, status, and a fractional-indexed `position`.
- **Column** — a kanban column. Has a `column_type` (`backlog`, `active`, `review`, `done`, etc.) that drives pipeline transitions. Column types are semantic; column names are human-facing.
- **Execution** — one LLM invocation by a runner. Records role, stage, model, cost, tokens, duration, status, input prompt, tool invocations, and ship warnings.
- **Runner** — the Go runner binary (`backplane-runner`); lives under `runner/`.
- **MCP** — Model Context Protocol. The way LLM hosts talk to tool servers. Backplane exposes its full tool census (drift-guarded in CI) plus 10 prompts over MCP.
- **Participant** — a user or runner associated with a card. Kinds: hero, helper, viewer, stakeholder. Distinct from "pipeline role."
- **Pipeline config** — per-workspace JSON describing stages, roles, scheduling. Owned by the backend; consumed by runners and frontends.
- **Prompt config** — a per-`(workspace, team, role, stage, slug)` prompt template. Layered over platform registry defaults and synthesized placeholders.
- **Role** — a pipeline persona (implementer, reviewer, documentator, or any custom). Drives prompt lookup and card filters.
- **Runner** — a credentialed Go process that executes pipeline stages. Formerly called "agent" in the UI; still called `agent` in schema.
- **Sensor** — a platform-side check that gates stage transitions (e.g., `pr_overlap` refuses to claim if another PR touches the same files).
- **Stage** — a step in the pipeline. Declared in `pipeline_config.stages[]`.
- **Team** — a grouping of runners by role. Per-workspace. A runner can belong to multiple teams (though the UI exposes only the first active team today).
- **Workspace** — the top-level tenancy unit. Slug-identified. Contains boards, members, channels, teams, pipeline config, budgets.

---

*End of historical synthesis. This snapshot is retained for design context; the live code and in-app documentation are authoritative. Detailed historical file:line references remain in [docs/research/](research/).*
