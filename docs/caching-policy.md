# Caching Policy

Architecture spec for caching in the Backplane platform at scale: many workspaces, thousands of users, boards, and cards. This is a policy document — it states the principles a cache must satisfy before it is added, the current tier layout, and what must never be cached. Cache mechanics that already exist are documented against their call sites; anything not yet built is marked forward-looking.

## Principles

1. **White-label, zero-dependency default.** The platform must run correctly on a single instance with no external cache. Every caching mechanism the default deployment relies on is in-process. Redis is a strictly opt-in Tier 2 (see below) and is currently unimplemented — the `redis` `EventBus` adapter raises `NotImplementedError` today. Nothing in the default path may require it.

2. **WebSocket-first freshness.** Live correctness comes from the event bus, not from expiring a cache. Query hooks subscribe to their domain's events (`useDomainSync`) and invalidate or patch on receipt; `staleTime` and `refetchInterval` are the *fallback* for a dropped socket, not the freshness mechanism. Every polling interval in the frontend is written `wsStatus === "connected" ? false : <fallback>` for exactly this reason (e.g. `frontend/src/features/approvals/hooks/useApprovals.ts:20`).

3. **Patch or scoped-invalidate — never blanket refetch.** A change to one board must not invalidate every board. The board-detail hook (`frontend/src/features/kanban/api/use-boards.ts`) scopes every WS subscription to the board whose UUID matches `payload.board_id` (`filter: isThisBoard`) and patches the highest-frequency mutation — a card move — directly into the cached board (`patch: patchBoardCache`) with no HTTP round-trip. `refetchOnWindowFocus` is globally `false` (`frontend/src/main.tsx:23`) because a tab-switch refetch storm against `/executions` helped take the DB down on 2026-07-23.

4. **One shared board-level query for any per-row derived set.** A value derived per card must be computed by a single board-level query that every row subscribes to, never by one query per row. `useCardHasSkippedExecution` (`frontend/src/features/agents/hooks/useAgentMetrics.ts:191-204`) is the canonical pattern: ~87 `KanbanCard`s share one `skippedCardIds(slug)` query that returns the full skipped-card union server-side; React Query dedupes the identical key into a single fetch and a single WS-driven refetch. The prior per-card `/executions?card_id=` wrapper mounted ~87 unindexed scans and re-invalidated all of them on each execution event — that is the anti-pattern this principle exists to prevent.

5. **A cache must name its invalidation event before it exists.** Do not add a cache whose entries you cannot say precisely when to evict. Every Tier-1 candidate below is paired with the bus event that evicts it. If no such event exists, the value goes on the DO-NOT-CACHE list until one does.

## Frontend policy

Global defaults (`frontend/src/main.tsx:13-26`): `staleTime` 30s; `refetchOnWindowFocus` false; `retry` uses `shouldRetry` (`frontend/src/lib/should-retry.ts`), which **never retries 429 or 5xx** and otherwise allows a single retry — load-shedding responses must not be amplified.

Per-data-class policy. "WS event" is the domain the hook subscribes to via `useDomainSync`; the poll interval is the fallback used only when the socket is disconnected.

| Data class | Freshness mechanism | Fallback poll | Verified at |
|---|---|---|---|
| Board list (workspace) | `activity.board.*` invalidation | global 30s staleTime | `use-boards.ts:11-23` |
| Board detail (structure + cards) | WS **patch** on card move + scoped invalidate on `card.*` / `column.*` / `activity.board.*` / `execution.*`, filtered to this board | global 30s staleTime (no explicit `staleTime`) | `use-boards.ts:26-116` |
| Board health | `agent.*` / card events scoped to the board UUID | 120s | `use-board-health.ts:48` |
| Executions (workspace) | `execution.*` invalidation | 60s (15s in live view) | `useAgentMetrics.ts:49` |
| In-flight executions | `execution.*` invalidation | 15s | `useAgentMetrics.ts:70` |
| Card execution history | `execution.*` for this card | 60s | `useAgentMetrics.ts:175` |
| Skipped-card ids (board-shared) | `execution.*` invalidation | 60s | `useAgentMetrics.ts:200` |
| Approvals | `approval.*` invalidation | 30s | `useApprovals.ts:20` |
| Agent metrics / improvement | `execution.*` + `agent.*` invalidation | 60s | `useAgentMetrics.ts:24` |
| Pipeline config | manual/`config.*` invalidation | 5m staleTime | `usePipelineConfig.ts:43` |
| Workspace config | manual/`config.*` invalidation | 5m staleTime | `useWorkspaceConfig.ts:41` |
| Notifications | `notification.created` (per-user) | 30m staleTime | `use-notifications.ts:259` |
| Current user | none (rarely changes) | 5m staleTime | `use-current-user.ts:21` |
| Lifecycle kinds (static config) | none | 60m staleTime | `lifecycleKinds.ts:37` |
| Budget status | none — polled | 60s (unconditional) | `useAgentMetrics.ts:90-96` |

Two rows read against the ideal and are worth calling out:

- **Board detail** has no explicit `staleTime` — it inherits the global 30s and leans entirely on WS patching + scoped invalidation. The forward-looking target is an explicit longer `staleTime` once the board GET is split into a cheap structure fetch plus WS patches (see roadmap). Documented here as it behaves today, not as the target.
- **Budget status** (`useAgentMetrics.ts:90-96`) polls at a flat 60s with **no** WS gate, because there is no `cost.*` event a client can subscribe to for its own budget total. `cost.threshold_crossed` fires only when a threshold is crossed, not on every spend, so it cannot drive a live running total. This is the one live poll with no WS fallback path, and it is the reason the roadmap lists a spend-tick event.

## Backend tiers

The backend caching model is tiered by dependency cost. Higher tiers are only reached when the lower tier provably cannot carry the load.

### Tier 0 — FastAPI per-request dependency cache (in effect today)

FastAPI memoizes a `Depends(...)` result within a single request: a dependency resolved once (e.g. `get_current_user`, `get_workspace` / `WorkspaceDep` in `backend/app/core/workspace.py`) is reused by every downstream dependency in that request rather than re-executed. This is already the platform's first line of cache and requires nothing — it is bounded to the request, so it is always correct and needs no eviction. Prefer expressing a shared per-request lookup as a dependency so Tier 0 handles it for free.

### Tier 1 — in-process TTL caches evicted by EventBus subscriptions (helper shipped; one read cached)

A short-TTL in-process cache whose entries are evicted by a bus subscription, not just by TTL expiry. The eviction subscriber is the same `event_bus.subscribe(...)` code the WS layer already uses. The helper lives in `backend/app/core/cache.py` (`TtlCache` + `WorkspaceSlugCache`); the gate is `CACHE_SINGLE_INSTANCE` (default false) OR a postgres bus. Candidates, each paired with its eviction event:

| Candidate | TTL | Evicted by | Status |
|---|---|---|---|
| slug → workspace resolution | 45s | `activity.workspace.*` | **shipped** — `backend/app/core/workspace.py` `WorkspaceDep._resolve_workspace` |
| effective workspace config | until evicted | `config.changed` (`entity="workspace_config"`) — event already emitted in `backend/app/services/workspace_config.py` | candidate |
| board / workspace list stats | 15–30s | `activity.board.*` / `activity.card.*` | candidate |

**The architectural seam:** under `EVENT_BUS_BACKEND=postgres` the *same subscriber code* becomes cross-instance-correct, because the eviction event arrives on every instance via `LISTEN`/`NOTIFY`. Under the default `memory` bus, a Tier-1 cache is only correct on a single instance — an eviction fired on instance A never reaches instance B's copy. Therefore **any Tier-1 cache is gated on the postgres bus for any deployment with `maxScale > 1`.** On the memory bus, keep Tier-1 caches to values whose staleness is tolerable within one TTL, or do not add them. See `docs/eventbus-pluggable-backend-plan.md`.

### Tier 2 — opt-in Redis (unbuilt)

A shared out-of-process cache. Not built; the `redis` `EventBus` adapter raises `NotImplementedError`. Reach for it only if a Tier-1 cache demonstrably outgrows what Postgres `NOTIFY`-driven eviction can carry (e.g. eviction fan-out volume or per-instance memory pressure). It remains strictly opt-in and must never enter the default deployment path.

## DO-NOT-CACHE

These reads and writes must hit the database (or their authoritative source) every time. Each entry names why.

| Path | Reason |
|---|---|
| Workspace membership / role checks (`backend/app/core/workspace.py:40-58`) | Tenancy and authorization. A stale membership or role is a security boundary violation; a demoted or removed member must lose access immediately. |
| Scheduler / `next_assignment` reads + reservation-eligibility predicates | Correctness of card dispatch depends on live board state; a cached predicate re-dispatches work already in flight (the loop class the runner consolidation exists to kill). |
| Merge-queue `pop_next` (`backend/app/repositories/merge_queue.py:60-81`, `SELECT ... FOR UPDATE SKIP LOCKED`) | Row-level lock is the concurrency primitive; caching the pop would let two workers claim the same entry. |
| Budget / cost-breaker + no-progress caps | Money-loop protection. These reads exist to stop runaway spend; a stale read defeats the breaker. |
| Approval status | A decided approval must be observed as decided on the next read; caching risks acting on a superseded decision. |
| API-key verification (`backend/app/core/auth.py:55-75` → `ApiKeyService.verify_key`) | Revocation must be immediate, and **no eviction event exists** for key revocation — caching it would keep a revoked key valid until TTL. |
| Auth auto-provision write path (`UserRepository.get_or_create`, `backend/app/routers/events.py:110`) | A write, not a read — there is nothing to cache, and the get-or-create must observe concurrent creates. |

## Roadmap

Prioritized, forward-looking. Card ids are placeholders — the orchestrator fills exact ids.

**Shipped (2026-07-23):**

- Response gzip: `GZipMiddleware(minimum_size=1024)`, added FIRST so it sits innermost — it must see the sized route response before the `BaseHTTPMiddleware` layers re-stream it without `Content-Length`, which would defeat `minimum_size` (`backend/app/main.py`, comment at the `add_middleware` site).
- Board-scoped frontend WS invalidation + card-move cache patch (`use-boards.ts` `isThisBoard` / `patchBoardCache`), plus board-scoping for board health and board-scoped activity feeds (`use-board-health.ts`, `use-activity.ts` with `maxPages: 3`).
- Board-shared skipped-card-ids query replacing per-card execution scans (`useAgentMetrics.ts:191-204`).
- Never-retry-429/5xx retry predicate (`should-retry.ts`).
- Scheduler config-lint skip: `include_warnings=False` on the scheduler's hot `get_config` calls — the prompt-content wiring lint no longer runs per runner poll (`backend/app/services/workspace_config.py`).
- Board timeline default limit lowered 5000 → 500 (`backend/app/routers/activity.py`; explicit `limit` retained where the replay view needs depth).
- `card_dependencies` `has_table` memoization: the existence probe caches its True result per process (`backend/app/services/kanban/card.py`).

**Carded next** (Backplane board, `internal-projects`):

- Board-detail: patch-instead-of-refetch for all board mutations + a cheap summary board GET, so board structure can carry an explicit long `staleTime` (card `b087487f`).
- ~~Tier-1 in-process cache helper (TTL + bus-eviction subscription), gated on the postgres bus for `maxScale > 1` (card `a5acdb8f`)~~ — **shipped**; the two remaining Tier-1 candidates above are separate cards.
- Skipped-card-ids horizon: bound the union query's scan window so it stays cheap as execution history grows (card `b6277c58`).
- `GET /executions/{id}`: today `useExecution` fetches the workspace list and finds one row client-side (`useAgentMetrics.ts:206-215`); a direct endpoint removes the over-fetch and the 50-row window miss (card `882a58a6`).
- Rate-limit keying hardened (card `7567043c`).
- IAP cert `Cache-Control` handling for the public-key fetch (`backend/app/core/auth.py:15,24-25`) (card `5e00fdc3`).
