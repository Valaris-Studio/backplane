# Event Taxonomy

Reference catalog of every event emitted on Backplane's internal event bus. Payloads and semantics were extracted from the backend publish sites and the frontend/runner subscribers — not from any design doc.

## Overview

- **Bus**: `app.core.event_bus.EventBus` — in-process async pub/sub, `fnmatch`-based pattern subscriptions, workspace-scoped. Module singleton at `app.core.event_bus.event_bus`. Fire-and-forget: subscriber errors are logged, never raised.
- **Pluggable backend** (`EVENT_BUS_BACKEND`, default `memory`): the singleton is built by `_make_event_bus()`. The local fan-out (`_dispatch_local` — workspace filter + `fnmatch` + gather) is identical across backends; only *where `publish` sends the event before local delivery* varies. The bus interface (`publish`/`subscribe`) is unchanged, so every publisher/consumer above and `ConnectionManager` work untouched regardless of backend.
  - `memory` (default) — local fan-out only. Zero config, zero dependencies, correct on a single instance. This is the documented single-instance deployment profile.
  - `postgres` — cross-instance fan-out via Postgres `LISTEN`/`NOTIFY` (channel `valaris_events`) on a dedicated long-lived `asyncpg` connection (`AsyncpgNotifyTransport`), opened in app startup and auto-reconnecting on drop. `publish` does local fan-out **and** `NOTIFY`; a `LISTEN` task re-injects remote events via `_dispatch_local` only (no re-`NOTIFY` echo loop). Each instance tags its `NOTIFY`s with a per-instance `origin_id` and skips its own echo (no double-delivery). Solves the multi-instance WS staleness gap **with no new dependency** — uses the database we already run. **Implemented and enabled in prod** (`EVENT_BUS_BACKEND=postgres` is set in `cloudbuild.yaml`); see `docs/eventbus-pluggable-backend-plan.md`.
  - `redis` — reserved for a future scale-tier adapter; currently raises `NotImplementedError`.
- **Remote-origin webhook rule**: a `remote=True` event (one received over the wire via `LISTEN` and re-injected into local fan-out) is delivered to WS subscribers on every instance, but **webhooks fire only on the originating process**. `WebhookSubscriber._handle_event` returns early when `event.remote` is set (`backend/app/services/events/webhook_subscriber.py:31`), so an external webhook is POSTed exactly once by the instance that published the event, not once per instance in the fleet. WS delivery is fleet-wide; webhook delivery is origin-only.
- **Event shape**: `{ event_type: str, workspace_id: UUID, payload: dict, timestamp: datetime, event_id: UUID, remote: bool }` (`Event` dataclass in `backend/app/core/event_bus.py:54`). `remote` defaults `False` and is set `True` only on events re-injected from another instance. It is process-internal: `ConnectionManager` builds WS frames from explicit fields and the wire encoding omits it, so neither WS clients nor webhook consumers ever see `remote`.
- **Event-name constants**: `backend/app/core/events.py`. Not every event type has a constant here: the `merge_queue.*` and `notification.created` names are module-level string constants in their owning services (`backend/app/services/merge_queue.py`, `conflict_consolidator.py`, `notifications/live_push.py`), and `activity.*` names are generated at the `ActivityService.record` call site. The taxonomy below is therefore broader than the constants file; avoid pinning a count that drifts whenever a lifecycle event is added.
- **Publishers**: backend services only (never routers, never repos). Call sites:
  - `backend/app/services/activity.py` — all entity lifecycle mutations via `ActivityService.record`, which publishes `activity.{entity}.{action}` unconditionally plus the deprecated bridge events (`card.*`, `column.*`).
  - `backend/app/services/approvals/approval.py`
  - `backend/app/services/agents/{agent,execution,team,prompt_config,liveness,cost}.py`
  - `backend/app/services/workspace_config.py`
  - `backend/app/services/alerts/alert_threshold.py`
  - `backend/app/services/merge_queue.py`, `backend/app/services/conflict_consolidator.py`
  - `backend/app/services/notifications/live_push.py` (deferred publish after commit)
- **Consumers**:
  - `backend/app/services/events/connection_manager.py` — bridges bus events to workspace WebSocket connections (`/ws/workspaces/{slug}/events`). Subscriptions are per-connection, pattern-based, set by the client via `{"subscribe": [...]}` frames. Applies per-user targeting for `notification.created` (see below).
  - `backend/app/services/events/webhook_subscriber.py` — subscribes to `*`, fans every **origin** event out to configured HTTP webhooks via `EventEmitter` (skips `remote` events).
  - Frontend: `frontend/src/lib/websocket.ts` + `frontend/src/hooks/use-websocket.ts` (`useWebSocketEvent(pattern, cb)`). `useDomainSync(domain, queryKey)` is the React-Query invalidation wrapper.
  - Runner: `runner/internal/events/client.go` routes events to its poll-trigger channel.

## Actor conventions

Three identifier fields appear in payloads; they are not interchangeable.

| Field | Meaning | Where it appears |
|---|---|---|
| `actor_id` | Who performed the action (a user or an agent). Stringified UUID of the authenticated principal. | `activity.*`, `card.*`, `column.*` (set from `ActivityService.record(actor_id=...)`). |
| `agent_id` | The agent the event is *about*. | `approval.created`, `execution.*`, `agent.status_changed`, `agent.heartbeat_received`, `agent.paused`/`agent.resumed`, and the `config.changed` payloads that concern a specific agent. |
| `target_agent_id` | The agent the event is *directed at*. Used exclusively to route commands through the shared workspace bus to one specific agent. | `agent.poll_requested` and `agent.restart_requested`. |

The runner uses these to avoid self-trigger loops: it drops any event where `payload.agent_id == self` or `payload.actor_id == self`, *except* for the directed commands `agent.poll_requested` and `agent.restart_requested`, which it acts on only when `payload.target_agent_id == self`. Those two are matched exactly and **before** the self-suppression filter — a command addressed to this runner arrives stamped with its own id, so ordering them after the filter would silently swallow every one (`runner/internal/events/client.go:264-312`).

## Events by namespace

Legend: **(UI)** = at least one frontend subscriber exists; **(bus-only)** = only backend/runner/webhook consumers.

### activity.* (primary fan-out)

`ActivityService.record` unconditionally publishes `activity.{entity_type.value}.{action.value}` for every call. This is the authoritative observability surface — every entity mutation that passes through `ActivityService` lands on the bus. Subscribers use `fnmatch` patterns (e.g. `activity.note.*`, `activity.*.deleted`, `activity.*`) to filter.

Published payload shape (`backend/app/services/activity.py`; the durable row
also carries fields that are not put on the bus, such as before/after state and
the acting-agent reference):

```
{
  "entity_type": "<board|column|card|note|resource|definition|channel|git_repo|workspace|member|agent>",
  "entity_id": "<uuid>",
  "action": "<ActivityAction value; see emitted pairs below>",
  "actor_id": "<uuid>",
  "board_id": "<uuid|null>",
  "summary": "<str>",
  "message_key": "<stable i18n key|null>",
  "message_params": { ... } | null,
  "changes": { ... } | null
}
```

`message_key` and `message_params` are additive localization metadata. New
system-authored activities should supply them; consumers must fall back to
`summary` for legacy rows or an unknown key. Parameters are data, not already
translated prose.

The following `(entity, action)` pairs are currently emitted (grep `entity_type=ActivityEntityType` under `backend/app/services/` to round-trip):

| Namespace | Events |
|---|---|
| `activity.card.*` | `created`, `updated`, `moved`, `deleted`, `dependency_added`, `dependency_removed`, `dependencies_replaced` |
| `activity.column.*` | `created`, `updated`, `deleted` |
| `activity.board.*` | `created`, `updated`, `deleted` |
| `activity.note.*` | `created`, `updated`, `deleted` |
| `activity.resource.*` | `created`, `updated`, `deleted` |
| `activity.definition.*` | `created`, `updated` |
| `activity.channel.*` | `created`, `updated`, `deleted` |
| `activity.git_repo.*` | `created`, `updated`, `deleted` |
| `activity.workspace.*` | `created`, `updated` |
| `activity.member.*` | `added_member`, `removed_member` |
| `activity.agent.*` | `activity.agent.updated` for pause, resume, poll request, restart request and deactivate lifecycle records; `activity.agent.deleted` for hard delete. The exact verb is in `changes.lifecycle`. |

Agent lifecycle activity emits a stable key for each of the six lifecycle
verbs plus `agent_name` as structured data. Localized consumers render that
metadata and retain `summary` as the exact fallback for older rows or clients.
These records are best-effort and are omitted when the agent has no resolvable
workspace. `activity.agent.updated` and `activity.agent.deleted` are also absent
from `WebhookEvent`, so they reach bus subscribers but cannot currently be
selected in a configured outbound webhook.

Adding a new ActivityEntityType/ActivityAction value auto-creates the corresponding `activity.*` event at the next `ActivityService.record` callsite — no per-event boilerplate. Wire an optional `WebhookEvent` enum entry in `backend/app/models/webhooks/webhook.py` if external webhook subscribers should be able to target it.

The existing `tests/services/test_activity_event_fanout.py::test_webhook_event_enum_covers_all_recorded_activity_pairs`
checks a manually maintained pair list; it does not derive every call site and
currently omits the agent pairs above. Treat it as a partial canary, not proof
that every emitted activity is externally selectable.

### card.* (DEPRECATED — bridge events)

`card.created`, `card.updated`, `card.moved`, `card.deleted` are emitted **in parallel** with their `activity.card.*` twin by `ActivityService.record`. They are deprecated and will be removed after consumers migrate to the `activity.*` namespace. Same payload shape as `activity.card.*`.

| Event | Trigger | UI |
|---|---|---|
| `card.created` | `ActivityAction.created` on a `Card` entity. | (UI) — `useDomainSync("card", …)` in `use-boards.ts`, `use-board-health.ts`; ObserverPanel. |
| `card.updated` | `ActivityAction.updated` on a `Card`. | (UI) — same consumers. |
| `card.moved` | `ActivityAction.moved` on a `Card`. | (UI) — same consumers. |
| `card.deleted` | `ActivityAction.deleted` on a `Card`. | (UI) — same consumers. |

### column.* (DEPRECATED — bridge events)

`column.created`, `column.updated`, and `column.deleted` are emitted in parallel with their `activity.column.*` twins and are deprecated — subscribers should migrate to the `activity.column.*` namespace before the bridge sunset.

| Event | Trigger | UI |
|---|---|---|
| `column.created` | `ActivityAction.created` on a `Column` entity (bridge, deprecated). | (UI) — `useDomainSync("column", boardKeys.detail(...))` in `use-boards.ts`. |
| `column.updated` | `ActivityAction.updated` on a `Column` (bridge, deprecated). | (UI) — same consumer. |
| `column.deleted` | `ActivityAction.deleted` on a `Column` (bridge, deprecated). | (UI) — same consumer. |

### approval.*

Emitted by `ApprovalService`. Both surface in the UI (`useApprovals` subscribes to `approval.*`).

| Event | Source | Payload |
|---|---|---|
| `approval.created` | `ApprovalService.create_approval`. | `{approval_id, status, category, risk_score, action_description, agent_id}` |
| `approval.updated` | `ApprovalService.decide`. | `{approval_id, status, decided_by, decision_reason}` |

Note: `approval.updated` uses `decided_by` (a user UUID), not `actor_id`. `action_description` on `approval.created` is unbounded free text — a thin-payload overflow candidate (see below).

### execution.*

Emitted by `ExecutionService`. All surface in the UI (`useAgentMetrics`, `useExecutions`, `useImprovementStatus` subscribe to `execution.*`).

| Event | Source | Payload |
|---|---|---|
| `execution.started` | `ExecutionService.start_execution` (`agents/execution.py:88`). | `{execution_id, agent_id, action, input_summary, board_id, card_id}` |
| `execution.completed` | `ExecutionService.update_execution` when `status` is terminal (completed/failed/aborted/skipped) (`agents/execution.py:191`). | `{execution_id, status, cost_usd, tokens_used, output_summary, error_message, board_id, card_id, agent_id}` |
| `execution.warning` | `ExecutionService.record_warning` (`agents/execution.py:317`). In-flight, typed warning surface — **not** a completion signal; the underlying retry continues. Consumers switch on `kind`. | `{execution_id, agent_id, card_id, kind, message}` |

`input_summary`, `output_summary`, `error_message`, and `message` are unbounded free-text fields — the real thin-payload overflow candidates (see below).

### agent.*

`agent.status_changed` has **two distinct emitter shapes** — subscribers must handle both:

| Event | Source | Payload | UI |
|---|---|---|---|
| `agent.status_changed` (is_active shape) | `AgentService._emit_agent_events` when `is_active` flips (`agents/agent.py:462`). Also fires on `create_agent` re-activating a soft-deleted row and on `deactivate_agent`. | `{agent_id, is_active, previous_active}` | (UI) — `useAgents`, `useAgentDetail`, `useImprovementStatus` via `agent.*`. |
| `agent.status_changed` (liveness shape) | `LivenessTracker.scan_and_publish` on a true liveness transition (`agents/liveness.py:100`). Backup signal to the WS heartbeat. | `{agent_id, liveness, previous_liveness}` | (UI) — same `agent.*` subscribers. |
| `agent.heartbeat_received` | `AgentService.handle_ws_heartbeat` (WS-transported heartbeat only; the HTTP `POST /heartbeat` path does **not** publish) (`agents/agent.py:187`). | `{agent_id, status, last_seen_at, liveness}` — now carries the derived `liveness` alongside raw status. | (UI) — same `agent.*` subscribers. |
| `agent.paused` | `AgentService._set_paused` when an agent is paused (`agents/agent.py:415`). Idempotent — no event on a no-op re-pause. | `{agent_id, is_paused: true}` | (UI) — `agent.*` subscribers. |
| `agent.resumed` | `AgentService._set_paused` when an agent is resumed (`agents/agent.py:415`). Idempotent. | `{agent_id, is_paused: false}` | (UI) — `agent.*` subscribers. |
| `agent.poll_requested` | `AgentService.poll_agent`. Requires an active WS connection for the target agent; raises 503 otherwise. | `{target_agent_id}` | (bus-only) — consumed by the runner's `routeEvent` to fire its poll loop. No frontend handler. |
| `agent.restart_requested` | `AgentService.restart_agent`. **Only pipeline mode wires the restart channel.** The backend locates a live WS connection across workers through the `agent.restart_probe`/`agent.restart_ack` pair below. With no connection, a runner still inside the heartbeat window yields 409 `no_control_channel`; a silent one yields 503 `agent offline`. A loop runner without keep-alive has no WS client. A keep-alive loop does open a WS client for `board.loop_updated`, but does not wire `SetRestartRequested`; the directed restart can therefore be accepted and delivered yet is logged and ignored by that client. Stop loop mode with `set_board_loop` / the board's loop switch. | `{target_agent_id}` | (bus-only) — in pipeline mode the runner's `routeEvent` signals its restart channel, which drains exactly like SIGTERM (finish the in-flight card, exit 0). Coming back is the supervisor's job. No frontend handler. |
| `agent.restart_probe` | `AgentService._locate_control_channel`, only when the handling worker's own registry has no socket for the agent. **Internal worker-to-worker — never delivered to a WS client** (no runner or frontend handler; `connection_manager` consumes it and does not forward it). Addressed to the agent's first allowed workspace purely so the NOTIFY has a parseable `workspace_id`. | `{target_agent_id, correlation_id}` | (bus-only). |
| `agent.restart_ack` | `ConnectionManager._answer_restart_probe`, published by whichever worker actually holds the target's socket. Silence is the negative answer — a worker without the socket stays quiet, and the prober's 2s timeout means "no control channel anywhere". Carries the socket's own `workspace_id`, which is what `agent.restart_requested` is then published to. | `{target_agent_id, correlation_id, workspace_id}` | (bus-only). |
| `agent.hard_deleted` | `AgentService.hard_delete_agent` after the row is gone. Published only when the agent had a resolvable workspace; the delete is not rolled back if publishing fails. | `{agent_id}` | (UI) — `agent.*` subscribers drop the row. |

### config.*

`config.changed` is a single event type emitted by five distinct call sites. Every payload uses the unified shape `{entity, action, entity_id}`:

| Emitter | Trigger | `entity` | `action` | `entity_id` |
|---|---|---|---|---|
| `AgentService._emit_agent_events` (`agents/agent.py:404`) | Any `update_agent` / `deactivate_agent` / re-activation. | `"agent"` | `"updated"` | agent UUID |
| `TeamService.update_team` (`agents/team.py`) | Team update. | `"team"` | `"updated"` | team UUID |
| `PromptConfigService.create_config` / `update_config` / `delete_config` (`agents/prompt_config.py`) | Prompt-config CRUD. | `"prompt_config"` | `"created"` / `"updated"` / `"deleted"` | config UUID |
| `WorkspaceConfigService.update_config` (`workspace_config.py:1721`) | Workspace pipeline/config update. | `"workspace_config"` | `"updated"` | workspace UUID |

(UI) — `useConfigSync` subscribes to `config.*` and invalidates agent/team/prompt query keys. It does not read payload fields (invalidation is unconditional), so the unified shape is for third-party subscribers and webhook consumers. The `workspace_config` emission at `workspace_config.py:1721` is the eviction event named by the caching policy's Tier-1 effective-config cache candidate.

### cost.*

`cost.threshold_crossed` has **two distinct emitter shapes** — subscribers must handle both:

| Source | Trigger | Payload | UI |
|---|---|---|---|
| `AlertThresholdService._check_and_emit` (`alerts/alert_threshold.py:108`) | A configured alert threshold is crossed. | `{threshold_id, metric, operator, target_value, current_value, workspace_id, board_id}` | (UI) — `useCostAlerts` subscribes on `cost.threshold_crossed`. |
| Cost-breaker (`agents/cost.py:109`) | The spend breaker trips (dedup-windowed per workspace). | `{workspace_id, current_usd, threshold_usd, action, window_seconds}` | (UI) — same subscriber. |

There is no per-spend `cost.*` event — neither shape fires on every dollar spent, only on a crossing/trip. This is why the frontend budget total is polled rather than WS-driven (see `docs/caching-policy.md`).

### merge_queue.*

Emitted by `MergeQueueService._publish` (`backend/app/services/merge_queue.py`) and `ConflictConsolidatorService` (`conflict_consolidator.py`). The event names are module-level string constants in those services, not in `events.py`.

| Event | Trigger | Payload |
|---|---|---|
| `merge_queue.enqueued` | An entry is added to the merge queue. | `{entry_id, card_id, repo_id, integration_branch, pr_url, pr_branch, state, attempt_count}` (+ `error_message`/`merged_at` when set) |
| `merge_queue.merging` | An entry goes in-flight — published after the state transition, before the merge executor runs, so every outcome is preceded by it. | same base shape, `state` reads `merging` |
| `merge_queue.merged` | An entry merges successfully. | same base shape, includes `merged_at` |
| `merge_queue.conflict` | A merge hits a conflict. | same base shape |
| `merge_queue.failed` | A merge attempt fails. | same base shape, includes `error_message` |
| `merge_queue.ci_not_green` | A merge attempt is deferred because CI is not green; the entry is re-queued until `CI_GIVE_UP_ATTEMPTS`. | same base shape, includes `error_message` |
| `merge_queue.stale` | An entry first ages past `MERGE_QUEUE_STALE_THRESHOLD_SECONDS`. Emitted by `BoardHealthService._notify_newly_stale`, not by `MergeQueueService` — board health is where staleness is computed. Fires **once per entry**, latched on `merge_queue_entries.stale_notified_at`. `age_seconds` is measured from `first_enqueued_at` (when the entry entered the queue), NOT `enqueued_at` (the FIFO position, which `re_enqueue` bumps on every retry) — so a continuously-churning entry goes stale on schedule instead of staying permanently fresh. Rows predating migration 088 carry NULL and fall back to `enqueued_at`. | `{entry_id, card_id, board_id, repo_id, integration_branch, pr_url, state, attempt_count, age_seconds, classification}` (+ `error_message` when set) |
| `merge_queue.conflict_consolidator_created` | A consolidator card is created to resolve a conflict. | `{entry_id, original_card_id, consolidator_card_id}` |

### notification.created

Emitted by the in-app notification channel via a deferred, after-commit publish (`backend/app/services/notifications/live_push.py:99`). Staged inside the generation savepoint (`stage_push`), promoted past it (`promote_staged`), and flushed to the bus only after the outer transaction commits (`_flush_pending_pushes`, an `after_commit` listener) — so a rolled-back notification never produces a phantom badge.

Payload (`backend/app/services/notifications/channels.py:49-64`): `{notification_id, recipient_user_id, category, workspace_id, unread_delta, link}`.

**Per-user targeting**: unlike every other event (which is workspace-broadcast), `notification.created` is delivered only to the socket whose `user_id` matches the payload's `recipient_user_id`. `ConnectionManager._should_deliver` (`backend/app/services/events/connection_manager.py:70-82`) special-cases this event type; all other events pass through to every workspace subscriber unchanged. It is published under the recipient's `workspace_id`, so without this filter it would fan out to every socket on that workspace.

## Thin-payload contract (postgres overflow)

Under `EVENT_BUS_BACKEND=postgres` only, a `NOTIFY` payload that exceeds `_NOTIFY_PAYLOAD_LIMIT` (7900 bytes) cannot be sent whole — Postgres caps `NOTIFY` at ~8KB. `PostgresEventBus._notify` re-encodes such an envelope in a **thin** form via `_thin_payload` (`backend/app/core/event_bus.py:141`): it keeps only the entity-id keys in the `_THIN_ID_KEYS` allow-list plus a `_thin: true` marker, and the receiving instance treats it as a "something changed, go refetch" signal rather than a full snapshot. The wire envelope also carries `thin: true` so `_on_notification` knows it is a refetch trigger.

**What actually overflows.** No publisher puts a large `after_state`/`before_state` snapshot on the bus — those columns exist on the activity-log row but are not part of any published payload. The real overflow candidates are the unbounded free-text fields: `input_summary` / `output_summary` / `error_message` on `execution.*`, `message` on `execution.warning`, `action_description` on `approval.created`, and `summary` / `changes` on `activity.*`.

**Allow-list:** `card_id, board_id, column_id, workspace_id, note_id, resource_id, agent_id, execution_id, approval_id, team_id, channel_id, recipient_user_id, entity_id, actor_id, target_agent_id, entity_type, action, id` (`backend/app/core/event_bus.py:24-43`). The list is kept wide on purpose: it preserves not just the ids a receiver needs to refetch, but every field a consumer *filters on* — `entity_type`/`action` for `activity.*` fan-out patterns, `actor_id`/`agent_id`/`target_agent_id` for the Go runner’s self-suppression, `entity_id`/`card_id` for the frontend per-card filters. Dropping any of these from the thin form would silently no-op the consumer, so `activity.*` events survive a thin fallback with their type/action/actor context intact.

## WebSocket subscribe handshake and authorization

**The socket is silent until you subscribe.** `/ws/workspaces/{slug}/events`
accepts and authenticates the connection and then sends *nothing* — a
connection that never sends a subscribe frame receives zero events forever and
is indistinguishable, from the client side, from a workspace where nothing is
happening. This is the single most expensive trap in this transport: R14
concluded `agent.hard_deleted` was never emitted when in fact the probe had
simply never subscribed, and the control experiment (a card PATCH) produced
zero events too, which read as confirmation.

After the socket is accepted, the client declares what it wants with a frame:

```json
{"subscribe": ["card.*", "column.*"]}
```

The set is **replaced**, not merged, on every such frame — the browser client
(`frontend/src/lib/websocket.ts`) therefore always sends its *entire* registered
pattern set, and `{"unsubscribe": [...]}` is handled by re-sending the survivors.

**Not every pattern is available to every caller.** `app.routers.events`
partitions each requested list against `PRIVILEGED_SUBSCRIPTION_PATTERNS`:

| Patterns | Who may subscribe |
|---|---|
| `*`, `agent.*`, `execution.*`, `approval.*` | workspace **admin/owner**, or any runner-key connection |
| everything else (`card.*`, `column.*`, `activity.*`, `config.*`, `cost.*`, …) | any workspace member |

Two properties of the rule are deliberate:

- **Denial is per-pattern, not per-frame.** Because the client sends one merged
  list, rejecting the whole frame on account of `*` would take live board sync
  down with the observer. Allowed patterns subscribe; denied ones are dropped.
- **Runner-key connections are exempt from the human role hierarchy.** A runner
  key resolves to its *creating user*, whose workspace role is incidental, while
  the runner subscribes to `card.*`, `approval.*`, `execution.*`, `config.*`,
  `agent.*` as its normal control channel (`runner/internal/events/client.go`).
  Runners are bounded instead by `enforce_agent_scope` at connect time. A
  connection with no determinable role fails closed.

A denied pattern produces a control frame — not a close, and not a domain event
(it carries no `event` field, so pattern subscribers never see it):

```json
{
  "type": "subscription_denied",
  "error_code": "admin_required",
  "patterns": ["*", "agent.*"],
  "detail": "Observer-grade event subscriptions require the workspace admin or owner role."
}
```

The observer panel's admin check in the frontend is UX only; this is the
authoritative gate (card `6711c45e`).

### What an event frame looks like

Once subscribed, every matching domain event arrives in this envelope
(`ConnectionManager._deliver`, `backend/app/services/events/connection_manager.py`):

```json
{
  "event": "activity.card.updated",
  "payload": {"card_id": "…", "board_id": "…", "entity_type": "card", "action": "updated"},
  "timestamp": "2026-08-14T21:04:11.482913+00:00",
  "event_id": "6f1e…"
}
```

`event` is the routing key patterns are matched against — it is the field to
switch on, and its absence is what distinguishes a *control* frame
(`subscription_denied`, `{"type": "ping"}`) from a domain event. `payload` is
the per-event body documented per namespace above; under the postgres backend
it may arrive [thin](#thin-payload-contract-postgres-overflow), carrying only
ids plus `_thin: true`. `event_id` is a fresh UUID per publish, useful for
de-duplicating a reconnect window. There is no `workspace_id` on the wire — the
socket is already workspace-scoped by its URL.

### Why there is no hello/ack frame

A server hello naming the expected subscribe shape was considered and
**declined** (card `d8cbbec6`). Both existing clients — the browser
(`frontend/src/lib/websocket.ts`) and the Go runner
(`runner/internal/events/client.go`) — subscribe unconditionally on open and
neither waits for a server frame first, so a hello would be dead weight on
every connection and would only help a *hand-written* probe, which is exactly
the reader this section serves. Adding one later stays backward-compatible
(clients ignore frames with no `event` key), so this is a reversible "not yet",
not a closed door. Documentation is the fix; the trap was never knowing the
handshake existed.

## Transport gaps

The HTTP `POST /agents/me/heartbeat` endpoint (`routers/agents/agents.py`) is deprecated on an N→N+1→N+2 release schedule and does **not** publish `agent.heartbeat_received`; only the WebSocket-transported heartbeat path in `AgentService.handle_ws_heartbeat` publishes. This is intentional — the HTTP route is slated for removal, and any runner pinging it logs a WARN urging migration to `events.Client.SendHeartbeat`. UIs that rely on live last-seen indicators assume the WS path.

Event patterns that appear only in tests (`card.stale`, `card.tick`, `agent.tick`, `agent.started`, `approval.requested`, `execution.finished`) are fixtures in frontend / runner test files. No backend publisher exists for any of them; they are not part of the real taxonomy.

## Backend: emitting a new event

1. **Activity-shaped events (preferred)** — call `ActivityService.record(...)` from the owning service. The fan-out emits `activity.{entity_type.value}.{action.value}` automatically; no constants or enum entries are required for the event to land on the bus. If external webhook subscribers need to target it, add a matching entry to `WebhookEvent` enum (and mirror it in `backend/app/core/events.py` so the `WebhookEvent ⊆ events.py` canary stays green).
2. **Non-activity events** (approvals, executions, agent lifecycle, config, cost, merge queue, notifications) — emitted directly by their owning service:
   - Add the constant to `backend/app/core/events.py` (or, for the merge-queue/notification families, a module-level constant in the owning service, matching existing convention).
   - In the service (never a router, never a repo), import `event_bus` from `app.core.event_bus` and the constant.
   - Wrap the `await event_bus.publish(event_type=..., payload={...}, workspace_id=...)` call in `try/except Exception: logger.exception(...)` — publishing must never break the mutation.
   - Add the constant to `WebhookEvent` enum if external webhook subscribers should be able to select it.
   - If the payload can carry an unbounded free-text field, add its entity-id key to `_THIN_ID_KEYS` so the event survives a postgres thin fallback.

## Frontend: subscribing to an event

- Provider: `WebSocketProvider` (`frontend/src/providers/WebSocketProvider.tsx`) opens a single WS to `/ws/workspaces/{slug}/events` and multiplexes subscriptions.
- Low-level: `useWebSocketEvent(pattern, callback)` from `@/hooks/use-websocket`. `pattern` follows backend `fnmatch` rules — e.g. `"card.*"`, `"approval.*"`, `"cost.threshold_crossed"`, `"*"`.
- High-level (preferred for React-Query consumers): `useDomainSync(domain, queryKey, options?)` from `@/hooks/useDomainSync`. Listens on `${domain}.*` and invalidates (or patches, via `patch`) the given key on a trailing debounce to coalesce bursts; a `filter` scopes handling to events for one board. See `docs/caching-policy.md` for the patch-or-scoped-invalidate policy.
- The Observer panel (`frontend/src/features/observer/hooks/useObserverEvents.ts`) subscribes to `*` and filters to the `card|agent|execution|approval` namespaces for its event log.
