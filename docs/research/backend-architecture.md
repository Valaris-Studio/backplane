# Backend Architecture — Source of Truth

**Scope**: `backend/` directory of the Valaris Internal Platform.
**Stack**: FastAPI · async SQLAlchemy 2.x (asyncpg) · Postgres 16 · Alembic · Pydantic v2.
**Entry point**: `backend/app/main.py` (`create_app()`).

This document characterizes the backend as-built on commit `c5f7e87` (2026-04-19). It is a companion to the frontend and infrastructure sources of truth and is meant to be navigable by file:line references.

---

## 1. Layered Architecture

The canonical flow is **Router → Service → Repository → Model**, and it is enforced culturally (CLAUDE.md rules) rather than by import-time guards. In practice, the discipline is tight. Sampling ~15 feature modules turned up no cases where a router talks directly to a repository or a model — services own that mediation.

### What each layer owns

**Router** (`backend/app/routers/**`)
- FastAPI route declarations, request parsing, dependency wiring, response schema binding.
- Authorization happens implicitly via the `get_workspace` / `get_workspace_admin` dependencies (`backend/app/core/workspace.py:63-64`). The router does not otherwise authorize.
- Calls a single service method; returns a Pydantic schema.

**Service** (`backend/app/services/**`)
- Business logic, cross-repository orchestration, idempotency, authorization beyond "is a member".
- Records activity via `ActivityService.record(...)` and publishes events.
- Raises typed `ValarisError` subclasses (`backend/app/exceptions.py`), which the global exception handler (`backend/app/main.py:40-45`) translates to JSON.

**Repository** (`backend/app/repositories/**`)
- Pure data access. `BaseRepository` provides `get_by_id / list / count / create / update / delete` over a generic `ModelT` (`backend/app/repositories/base.py`).
- `update()` does `flush()` + `refresh()` to pick up `onupdate` columns — a gotcha documented in the project CLAUDE.md and observed in every repo subclass (e.g., `backend/app/repositories/base.py:36-41`).
- When a response schema includes nested relationships, repositories use `selectinload`. See `CardRepository.get_by_id` (`backend/app/repositories/kanban/card.py:17-23`) pulling participants and their users/agents in one call.

**Model** (`backend/app/models/**`)
- SQLAlchemy 2.x declarative models. `UUIDMixin` + `TimestampMixin` provide `id`, `created_at`, `updated_at` (`backend/app/models/base.py`).
- Relationships default to `lazy="raise"` — touching an unloaded relationship outside a repo that deliberately eager-loads it throws at runtime. This is a deliberate guardrail against accidental N+1 in async contexts where lazy loading would trigger `MissingGreenlet`.

### Representative trace: create a card

1. `POST /api/workspaces/{slug}/boards/{board_id}/cards` hits `backend/app/routers/kanban/cards.py:60-68`.
2. The router depends on `get_workspace` (membership check) and `resolve_board_id` (UUID-or-slug resolution + workspace scope check, `backend/app/core/workspace.py:67-99`).
3. `CardService.create_card` (`backend/app/services/kanban/card.py:184-214`) validates the target column belongs to the board, computes the new fractional position via `card_repo.get_max_position + 1024.0`, creates the card, and records an `ActivityAction.created` activity.
4. `CardRepository.create` (`backend/app/repositories/kanban/card.py:25-29`) inserts, flushes, and re-fetches with `selectinload` so the response includes the (empty) participants list.
5. `get_db` commits on the way out (`backend/app/database.py:9-16`).

### Representative trace: claim a card (with row locking)

`CardService.claim_card` (`backend/app/services/kanban/card.py:420-461`) is the interesting case. It:
- Uses `card_repo.get_for_update` (`backend/app/repositories/kanban/card.py:113-120`) to issue `SELECT ... FOR UPDATE`.
- Refuses the claim if a `hero` participant already exists (returns `409 already_claimed`).
- Resolves the runner's `agent_id` → owning `user_id` so the FK is satisfied while `agent_id` stays available for observability.
- Moves the card into the "In Progress" column when one exists — a soft convention the service looks up by name at runtime.

The `for update` lock is one of only a few places in the codebase; concurrent-claim is where the platform most obviously needs it.

### Representative trace: `ActivityService` as cross-cutting service

`ActivityService.record` (`backend/app/services/activity.py:39-84`) is called from every mutation service. It:
- Writes the activity row via `ActivityRepository`.
- Publishes to the in-process event bus under `activity.{entity}.{action}`.
- Additionally publishes a handful of legacy namespaced events (`card.created`, `column.updated`, …) for backwards compatibility; see "Event bus" below.

Because `ActivityService` reads `current_api_key_name` / `current_agent_id` from `ContextVar`s set by `get_current_user` (`backend/app/core/auth.py:19-22, 49-75`), activity rows record which API key and which registered agent performed the mutation — useful for forensics.

---

## 2. Data Model Overview

Every model derives from `Base` plus `UUIDMixin` (UUID primary key, `gen_random_uuid()` server default) and usually `TimestampMixin`. See `backend/app/models/__init__.py` for the registered set.

### Core workspace tenancy

- `Workspace` (`backend/app/models/workspace.py:19-27`) — `name`, `slug` (unique, indexed).
- `WorkspaceMember` — composite PK `(workspace_id, user_id)`, `role` (`owner / admin / member / viewer`). Role hierarchy enforced in `WorkspaceDep` (`backend/app/core/workspace.py:51-58`).
- `User` — `email` unique; auto-provisioned on first authenticated request.

### Kanban

- `Board` (`backend/app/models/kanban/board.py:10-29`) — `workspace_id`, `name`, `slug` (nullable for rolling-deploy safety; unique per workspace via `uq_boards_workspace_slug`), `description`, `tags` (JSON).
- `Column` — `board_id`, `name`, `position` (float), `column_type` (added in migration `029`).
- `Card` (`backend/app/models/kanban/card.py:54-77`) — `column_id`, **`board_id`** (denormalized; see below), `title`, `description`, `card_type`, `priority`, `position` (float), `created_by`, `due_date`, `status`, `labels` (JSON).
- `CardParticipant` — composite PK `(card_id, user_id)`, `role` (`hero / viewer / stakeholder / helper`), optional `agent_id`. One `hero` per card is enforced in the service layer, not via a unique constraint.

**Denormalization**: `cards.board_id` is redundant (derivable via `column.board_id`) but enables fast board-level queries — the board detail endpoint uses it to avoid joining through columns. The service keeps the two in sync explicitly on move (`CardRepository.move_card`, `backend/app/repositories/kanban/card.py:62-69`).

**Fractional indexing**: columns and cards use `Float` positions. New rows get `max_position + 1024.0` (`backend/app/services/kanban/card.py:192-201`); moves pass an arbitrary midpoint computed on the frontend. There is a short-circuit for no-op moves when the position delta is <1.0 (`backend/app/services/kanban/card.py:318-320`), which matters because the frontend sometimes re-fires move events on drag-end.

### Agents / runners / prompt configs

- `Agent` (`backend/app/models/agents/agent.py:21-59`) — runner registration. Owner is a user, linked to an `ApiKey`. Carries a large flat set of `health_*` columns that are written on heartbeat (CPU, uptime, card counts, current board/card, last error, port, go version, etc.). `sensor_catalog` (JSON) is self-reported so the platform can discover which sensors this build supports without hard-coding. Legacy `agent_type` enum remains.
- `AgentTeam` (`backend/app/models/agents/team.py:11-33`) — `workspace_id`, nullable `board_id`, `slug` (unique within workspace). `AgentTeamMember` composite PK carries `roles` as a JSON list (converted from scalar by migration `032`).
- `AgentExecution` (`backend/app/models/agents/execution.py:29-79`) — a single tick of a runner stage. `status` enum includes `skipped` (added migration `045`) meaning "the tick ran but no LLM work happened because no prompt was authored". Tracks cost, tokens, duration, parent execution (for pipeline chains), `cards_affected` (JSON list of card-id strings), `tool_invocations` (relationship), and `ship_warnings` (JSON, migration `047`) — non-fatal issues surfaced to the UI.
- `AgentPromptConfig` (`backend/app/models/agents/prompt_config.py`) — `(workspace_id, team_id, team_role, stage, slug)` is the unique scope. Rows with NULL workspace are the system defaults. Operators author team-scoped overrides.
- `ToolInvocation` — per-call record (name, args, result, duration) hanging off an execution (`backend/app/models/agents/tool_invocation.py`).

### Approvals

`ApprovalRequest` (`backend/app/models/approvals/approval.py`) — captures high-risk agent actions awaiting human decision. `category` ∈ {deletion, bulk_change, deployment, schema_change, permission_change, external_action}. Carries a `risk_score`; `ApprovalService.create_approval` auto-approves below `AUTO_APPROVE_THRESHOLD` (`backend/app/services/approvals/approval.py:27-32`). `expires_at` defaults to now + 24h.

Cards expose `has_pending_approval` + `pending_approval_id` transiently, populated in Python by `attach_pending_approvals` (`backend/app/services/kanban/card.py:20-44`) via a single batched SELECT per listing.

### Shared-scope entities

`Note`, `Resource`, `Channel`, `Definition`, `GitRepo` all sit under a workspace with an optional `board_id`:
- NULL `board_id` ⇒ workspace-scoped row.
- Non-NULL `board_id` ⇒ board-scoped row.

`Resource` (`backend/app/models/resources/resource.py:16-37`) carries GCS paths. Its `metadata` column is exposed as the Python attribute `meta` to avoid clashing with SQLAlchemy's `Base.metadata` — a gotcha worth calling out.

### Activity and webhooks

- `Activity` (`backend/app/models/activity.py:38-66`) — workspace-scoped audit log. `entity_type` / `entity_id` / `action`, optional `board_id`, `agent_id`, `via_api_key`, plus free-form `summary` and `changes` (JSON). Indexed on `(workspace_id, created_at)`, `(board_id, created_at)`, `(entity_type, entity_id)`, `actor_id`, `agent_id`.
- `Webhook` — outbound webhook subscriptions (URL + event-pattern + HMAC secret). Delivery is handled by `WebhookSubscriber` wired in `main.py` startup.

### Entity-relationship summary

```
Workspace 1—N Board 1—N Column 1—N Card 1—N CardParticipant N—1 User
          \                               \
           N— Note / Resource / Channel    N— Activity
           N— Definition / GitRepo         N— Agent (via created_by)
           N— AgentTeam                    N— AgentPromptConfig
           N— ApprovalRequest              N— WorkspaceMember N—1 User

Agent 1—N AgentExecution 1—N ToolInvocation
AgentTeam 1—N AgentTeamMember N—1 Agent
```

---

## 3. Auth & Tenancy

### Three-tier authentication

Implemented in `backend/app/core/auth.py:49-99`. Resolution order:

1. **API key** (`Authorization: Bearer vlr_...`) — bespoke prefix to distinguish from IAP OIDC JWTs. Verified via `ApiKeyService.verify_key`; sets `current_api_key_name` (and `current_agent_id` if the key is bound to an agent) in `ContextVar`s read downstream by `ActivityService`.
2. **Dev mode** (`settings.is_development`) — trusts the `X-User-Email` header, defaults to `dev@valaris.dev`. No cryptography.
3. **Prod + `IAP_AUDIENCE` set** — validates `X-Goog-IAP-JWT-Assertion` against Google's public keys using `google.oauth2.id_token.verify_token` with `IAP_CERTS_URL`. Email extracted from claims.
4. **Prod + `IAP_AUDIENCE` empty** — trusts the `X-Goog-Authenticated-User-Email` header (with `accounts.google.com:` stripped). Graceful fallback when the audience env var has not been configured yet.

### Auto-provisioning

If the resolved email has no matching `User` row, one is created on the fly (`backend/app/core/auth.py:93-98`). `name` is derived from the email local-part. There is no registration flow; the first request from a new user Just Works.

### Workspace-scoped endpoints

Every feature endpoint lives under `/api/workspaces/{slug}/...`. The `WorkspaceDep` dependency (`backend/app/core/workspace.py:23-60`) resolves `slug → Workspace`, verifies the current user has a `WorkspaceMember` row, and optionally enforces a minimum role via a numeric hierarchy (`owner=0 < admin=1 < member=2 < viewer=3`).

Two convenience instances are exported:
- `get_workspace` — any member.
- `get_workspace_admin` — requires `admin` or `owner`.

The returned `WorkspaceContext` bundles `workspace`, `membership`, `user`, which routers destructure with `ctx.user.id` / `ctx.workspace.id`.

### Board-scoped endpoints

`resolve_board_id` (`backend/app/core/workspace.py:67-99`) accepts `{board_id}` as either a UUID or a slug and verifies the board belongs to the workspace — so child routers do not repeat the cross-check.

---

## 4. Domain Services

Services live under `backend/app/services/**`. The inventory below is grouped by domain.

### Kanban (`services/kanban/`)
- `BoardService` — CRUD plus the "detail" endpoint that eager-loads columns and cards via `selectinload` in one query (documented in the project CLAUDE.md).
- `CardService` — CRUD, search (multi-filter), bulk create, move, participant management, atomic claim. Two module-level helpers (`attach_pending_approvals`, `attach_agent_presence`) batch-annotate cards with transient fields for the frontend (`backend/app/services/kanban/card.py:20-133`).
- `ColumnService` — CRUD + reorder.
- `BoardContextService` — the "give me everything for this board in one call" endpoint.
- `BoardHealthService` — computed metrics (stale/overdue/unassigned cards, velocity, health score).

### Agents (`services/agents/`)
- `AgentService` — runner registration, API key rotation, heartbeat handling, status events. Idempotent on `(owner, name)`: repeating a create returns the existing agent and reactivates it if it had been soft-deleted (`backend/app/services/agents/agent.py:36-44`).
- `ExecutionService` — `start_execution` / `update_execution` with terminal-status detection; emits `execution.started` and `execution.completed` via the event bus (`backend/app/services/agents/execution.py:65-122`).
- `PromptConfigService` — CRUD plus **content resolution**. When serializing, appends a stage-specific post-process imperative to the prompt body based on the workspace's pipeline config (`backend/app/services/agents/prompt_config.py:68-87`). A paste-guard checks canonical prefixes so double-appends do not happen when operators paste the imperative themselves (`backend/app/services/agents/prompt_config.py:21-39`). Exposed as `resolved_content` on the response.
- `SensorService` — reads the self-reported `Agent.sensor_catalog` to drive UI.
- `TeamService` — CRUD for agent teams and memberships.
- `ToolInvocationService` — records tool call telemetry from runners.
- `ExportService` — exports team/prompt config to portable JSON.

### Approvals (`services/approvals/`)
- `ApprovalService` — create / list / get / decide (`approve` / `reject`). Transitions from `pending` are one-way; repeat decisions raise `409` (`backend/app/services/approvals/approval.py:92-93`).
- `risk.py` — `compute_risk_score(category, payload)` + `AUTO_APPROVE_THRESHOLD`. Category-aware heuristic that operators can tune in code.

### Cross-cutting
- `ActivityService` — already covered. Every mutation service calls `record(...)`.
- `ApiKeyService` — creates and verifies `vlr_...` API keys; stores hashed material only.
- `WorkspaceService` — workspace and member CRUD, also idempotent on slug collision and duplicate membership (`backend/app/services/workspace.py:29-48, 80-92`).
- `WorkspaceConfigService` (`services/workspace_config.py`) — per-workspace JSON config blob, notably the pipeline config (stages, roles, LLM per-stage settings).
- `ImprovementTriggers` (`services/improvement_triggers.py`) — fans ad-hoc "improver" agent runs off triggers.
- `MetricsService` — aggregation for the dashboard.
- `PipelineConfigValidation` — schema-checks operator-authored pipeline configs before they land.
- Feature services: `NoteService`, `ResourceService` (+ `GcsService`), `ChannelService`, `DefinitionService`, `GitRepoService`, `WebhookService`, `AlertThresholdService`.

### Events layer (`services/events/`)
- `ConnectionManager` — holds live WebSocket connections, routes subscriptions into the in-process `EventBus`. Module-level singleton (`backend/app/services/events/connection_manager.py:108`).
- `WebhookSubscriber` — subscribes to `*` at startup, dispatches every event to `EventEmitter` for outbound webhook fan-out with a fresh DB session per event (`backend/app/services/events/webhook_subscriber.py`).

---

## 5. Event Bus & Activity Flow

### In-process bus

`EventBus` in `backend/app/core/event_bus.py:32-81` is a subscribe/publish ring backed by a list of `(workspace_id, fnmatch_pattern, callback)` tuples. Subscriptions can be global or workspace-scoped; patterns use shell globs (`activity.*.deleted`, `activity.card.*`, `*`). Publish is fan-out via `asyncio.gather(..., return_exceptions=True)` — subscriber errors are logged but never propagated to the publisher.

A single module-level singleton `event_bus` is exported. Services publish, the connection manager and the webhook subscriber consume.

### `activity.{entity}.{action}` fan-out

`ActivityService.record` writes the DB row, then always publishes `activity.{entity_type}.{action}` (`backend/app/services/activity.py:78-79`). Subscribers can do fine-grained filtering purely via fnmatch patterns.

In parallel, a small map of **bridge events** (`card.created`, `card.updated`, `card.moved`, `card.deleted`, `column.created`, `column.updated`, `column.deleted`) is emitted alongside for backward compatibility (`backend/app/services/activity.py:19-27`). The map is explicitly labelled deprecated with a "do not extend" comment; consumers should migrate to the `activity.*` namespace.

Service-specific events that are not activity-shaped — `execution.started / completed`, `approval.created / updated`, `agent.status_changed / heartbeat_received / poll_requested`, `config.changed`, `cost.threshold_crossed` — are defined in `backend/app/core/events.py` and published directly from their owning services.

### WebSocket delivery

`ConnectionManager.update_subscriptions` (`backend/app/services/events/connection_manager.py:53-67`) re-subscribes the connection to the `EventBus` each time the client sends a `{"subscribe": [...]}` frame. Each pattern becomes one `EventBus` subscription whose callback serializes the `Event` as JSON and sends it over the socket.

The WebSocket router is `backend/app/routers/events.py`. Key bits:
- Authentication mirrors HTTP: API key via `?token=vlr_...`, or IAP JWT header, or the `X-Goog-Authenticated-User-Email` fallback, or `X-User-Email` in dev (`backend/app/routers/events.py:47-112`).
- On accept, the connection is registered; on disconnect, all `EventBus` subscriptions are unwound (`ConnectionManager.disconnect` calls the stored `unsubscribe` closures).
- Heartbeat: the server sends a `{"type": "ping"}` every `WS_HEARTBEAT_INTERVAL` seconds (`backend/app/routers/events.py:167-175`). Client may reply with `{"type": "pong"}`.
- Agents additionally push `{"type": "heartbeat"}` frames on the same socket; `_handle_heartbeat_frame` dispatches to `AgentService.handle_ws_heartbeat` in its own session (`backend/app/routers/events.py:136-161`).

### Known rough edges (from recent commits and feedback notes)

- **Subscription timing races**: the client must send its `subscribe` frame after the server has `accept()`ed the socket. There is no replay of missed events between connect and subscribe. The frontend feedback notes (`memory/feedback_websocket_bugs.md`) describe React StrictMode and provider-timing races that bit the UI; the backend side of that is just the absence of replay/buffering.
- **Bridge events are deprecated but still firing**: commit `0e00127` explicitly restored `column.updated / deleted` as bridge events after a regression. Sunset is planned but not scheduled.
- **Webhook delivery is fire-and-forget**: no retry queue, no outbox. `WebhookSubscriber` opens a fresh session per event; failures are logged and lost.
- **`_event_log_enabled` reads env on every publish** (`backend/app/core/event_bus.py:13-17`) — a deliberate debug lever that can be flipped without restart but also never enable in prod (PII leaks via payloads).

---

## 6. Migrations & Deployment Safety

Alembic is vendored at `backend/alembic/` with `env.py` overriding the config URL from `app.config.settings`. Migrations run automatically on container startup (`start-prod.sh`), and Cloud Run does rolling updates — so old and new code briefly coexist against the new schema.

### Conventions

Revisions are sequential three-digit IDs: `001_initial_schema.py` through `047_add_ship_warnings_to_executions.py`. Each new migration cites the preceding one in `down_revision`; there are no branches.

Rolling-deploy rules (codified in `.claude/rules/migrations.md` and observed in the migrations themselves):

- **Adding columns**: always `nullable=True` or `server_default`. `047_add_ship_warnings_to_executions.py:29-32` is canonical.
- **Adding `slug` columns**: added as `nullable=True` even though the app always writes them, because older pods still running may not. See `boards.slug` (`backend/app/models/kanban/board.py:21`) and migrations `040`, `042`, `043`.
- **Removing columns**: two deploys — stop reading first, drop second. Not observed in recent migrations.
- **Renames**: prohibited. Add new column, backfill, drop old.
- **Adding tables**: always safe; no coordination needed.
- **Dropping tables**: only after removing all code references.
- **Never edit a landed migration** — a new one supersedes.

### Notable migrations worth knowing about

- `019_add_agent_teams_and_prompt_configs.py` — introduced the team/prompt-config model.
- `032_convert_team_member_roles_to_array.py` — scalar→JSON array migration, data-migration pattern.
- `036_add_pipeline_config.py` — moved pipeline config into `workspace_configs`.
- `039_rewrite_live_prompt_stages_to_dsl_tokens.py` — in-place data rewrite of a live column.
- `040_add_board_slug.py` / `041_add_prompt_config_unique_slug.py` / `042_add_team_slug.py` / `043_add_git_repo_slug.py` — the UUID→slug migration wave driven by the `scoping_slug_identity.md` audit; each adds a nullable slug and a unique constraint without backfilling hot paths.
- `045_add_execution_status_skipped.py` — enum extension for "no prompt authored → skip gracefully".

---

## 7. Idempotency

The project CLAUDE.md codifies idempotency as a first-class requirement: **create/add endpoints return the existing entity (200/201) instead of `409 Conflict` when the target already exists.** The rationale is LLM-retry resilience — multi-role agents in a pipeline can hit the same endpoint from different stages, and LLMs retry on partial failure.

### Where the pattern is enforced

- `AgentService.create_agent` — idempotent on `(owner, name)`. Reactivates soft-deleted agents on re-create (`backend/app/services/agents/agent.py:31-44`).
- `WorkspaceService.create_workspace` — idempotent on `slug` (`backend/app/services/workspace.py:29-34`).
- `WorkspaceService.add_member` — returns the existing `WorkspaceMember` on duplicate (`backend/app/services/workspace.py:87-92`).
- `CardService.add_participant` — returns the card unchanged if the user is already a participant (`backend/app/services/kanban/card.py:365-367`).
- `PromptConfigService.create_config` — idempotent on the full scope tuple `(workspace_id, team_id, team_role, stage, slug)` (`backend/app/services/agents/prompt_config.py:171-181`).

### Where it is intentionally *not* idempotent

- `CardService.claim_card` — a second claim attempt when a hero already exists raises `409 already_claimed`. This is deliberate: concurrent claims must visibly race.
- `CardService.add_participant` with `role="hero"` — if a different user is already hero, returns `409 already_claimed` rather than silently re-hosting (`backend/app/services/kanban/card.py:369-372`).
- `ApprovalService.decide` — re-deciding a non-pending approval is `409` (`backend/app/services/approvals/approval.py:92-93`).

---

## 8. Honest Limitations

A candid list of rough edges based on code, recent commits, and the maintainer's own feedback notes:

### Event system
- **No event durability**. `EventBus` is in-process, single-pod. If a Cloud Run instance dies mid-handler, queued callbacks vanish. This is acceptable for activity notification but would bite anything financially consequential.
- **WebSocket subscription race**. Feedback notes (`memory/feedback_websocket_bugs.md`) flag several "needs-reload to see live updates" bugs rooted in subscribe-timing. The backend offers no event replay between connect and `subscribe`, so any event published in that window is lost to the client.
- **Bridge events still shipping**. `card.*` and `column.*` double-publish alongside `activity.*.*` and are deprecated but unscheduled for removal (`backend/app/services/activity.py:19-27`).

### Auth surface
- **IAP fallback trusts a header**. When `IAP_AUDIENCE` is empty, the backend trusts `X-Goog-Authenticated-User-Email` unconditionally (`backend/app/core/auth.py:82-85`). This is fine behind IAP but would be dangerous if the Cloud Run service were ever made directly internet-routable. No runtime check for "is IAP actually in front of me".
- **API-key material lifecycle**. Keys are hashed-at-rest, but rotation deletes the old key row immediately rather than expiring it with a grace window (`backend/app/services/agents/agent.py:76-79`). A mid-flight request with the old key will 403 rather than gracefully rolling over.

### Data integrity
- **`CardParticipant` uniqueness by convention**. The "one hero per card" rule lives in the service (`backend/app/services/kanban/card.py:369-372, 429-431`). No DB constraint enforces it. A racing path outside those two entry points could double-write.
- **`cards_affected` is opaque JSON**. Queries that need "is this card under a running execution?" resolve membership in Python across dialects (`backend/app/services/kanban/card.py:88-100`). Correct, but every such query is O(running executions × cards).
- **`board_id` on cards is denormalized** — services that move cards must update both `column_id` and `board_id` in lockstep. `CardRepository.move_card` does, but a bug in any future mutation path could drift them.

### Migration / deploy
- **Migrations run on startup**. Adopting a slow migration can block every rolling Cloud Run revision coming up. No separate migration job.
- **No enforced downgrade testing**. Downgrade functions exist but are not exercised in CI; some of them drop data.

### Audit coverage
- The 2026-04-17 audit (`memory/audits/audit_backend.md`, referenced from the auto-memory) called out 4 Critical authz/idempotency issues and 7 Major items. Resolution status is not tracked in code; the audit report is the source of truth for what is still open.

### Testing
- Tests use in-process SQLite (aiosqlite) rather than Postgres (`CLAUDE.md`). A handful of Postgres-only features (e.g., `gen_random_uuid()`, JSON containment, enum alterations) can pass tests and fail in prod. Datetime timezone handling differs too — tests compare components, not tz-aware objects.

---

## 9. Appendix

### Directory map

```
backend/
  alembic/versions/        (001..047, sequential)
  app/
    main.py                FastAPI factory, router wiring, event bus startup
    config.py              pydantic-settings, env vars
    database.py            async engine + session factory + get_db
    exceptions.py          ValarisError hierarchy
    core/
      auth.py              get_current_user (3-tier auth, auto-provision)
      workspace.py         WorkspaceDep, resolve_board_id
      event_bus.py         EventBus singleton
      events.py            event-type string constants
      rate_limit.py        middleware
      pagination.py
    models/**              SQLAlchemy 2.x models (grouped by domain)
    repositories/**        Data access; BaseRepository generic
    services/**            Business logic; one file per aggregate
    schemas/**             Pydantic v2 request/response schemas
    routers/**             FastAPI routers, thin adapters
    utils/                 utcnow(), small helpers
  tests/                   pytest + httpx.AsyncClient + SQLite
```

### File:line quick-reference

| Concern | File:Line |
|---|---|
| App factory | `backend/app/main.py:22-128` |
| Three-tier auth | `backend/app/core/auth.py:49-99` |
| Workspace dep | `backend/app/core/workspace.py:23-64` |
| Board slug resolver | `backend/app/core/workspace.py:67-99` |
| Event bus | `backend/app/core/event_bus.py:32-85` |
| Event constants | `backend/app/core/events.py` |
| ActivityService | `backend/app/services/activity.py:34-94` |
| Bridge events map | `backend/app/services/activity.py:19-27` |
| CardService.claim_card | `backend/app/services/kanban/card.py:420-461` |
| CardService idempotent add | `backend/app/services/kanban/card.py:365-367` |
| PromptConfigService resolve | `backend/app/services/agents/prompt_config.py:68-87` |
| ApprovalService auto-approve | `backend/app/services/approvals/approval.py:27-45` |
| BaseRepository | `backend/app/repositories/base.py` |
| CardRepository eager load | `backend/app/repositories/kanban/card.py:17-23` |
| Row lock | `backend/app/repositories/kanban/card.py:113-120` |
| WebSocket router | `backend/app/routers/events.py` |
| ConnectionManager | `backend/app/services/events/connection_manager.py` |
| WebhookSubscriber | `backend/app/services/events/webhook_subscriber.py` |
| Activity model indexes | `backend/app/models/activity.py:40-46` |
| Card model (board_id denorm) | `backend/app/models/kanban/card.py:54-77` |
| AgentExecution statuses | `backend/app/models/agents/execution.py:15-26` |
| AgentPromptConfig scope PK | `backend/app/models/agents/prompt_config.py:18-23` |
| Session commit/rollback | `backend/app/database.py:9-16` |

### Key conventions checklist for new code

- New endpoint → new router file under `app/routers/{domain}/` → included in `main.py`.
- Router depends on `get_workspace` (or `get_workspace_admin`) — no direct DB access in routers.
- Service holds the logic, calls `ActivityService.record` on every mutation, publishes events when appropriate.
- Repository uses `selectinload` if the response schema has nested relations.
- `create_*` / `add_*` methods are idempotent unless the business rule forbids it (hero-claim, approval-decide).
- New migrations are additive-first; never edit a landed one.
- Integration test with `httpx.AsyncClient` and `X-User-Email` header, function-scoped DB session.

