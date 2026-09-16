# Plan: Pluggable EventBus backend — scale WebSockets across instances with zero new dependencies

**Status:** Implemented (commit `93d2877`, PR #14) — hardened & enabled in prod 2026-07-23. The `postgres` backend now ships as the default in `cloudbuild.yaml`; `memory` remains the zero-config single-instance profile. This document is retained as the historical design record; §7 (the deploy landmine) is now permanently closed — see its dated note.
**Author context:** Written from a live investigation of the WS fan-out limitation and the current Cloud Run config (2026-06-26).
**Audience:** Backend devs who will scrutinize, refine, and implement.

---

## 1. TL;DR

The platform's WebSocket event delivery uses an **in-memory, per-process** `EventBus`. On Cloud Run with more than one instance, an event published on instance A never reaches a WS client connected to instance B. To work around this we currently pin the live service to **one instance** (`maxScale=1`), which removes autoscaling headroom and redundancy.

This plan proposes making the `EventBus` a **pluggable interface** with three backends:

- **`memory`** (default) — today's behaviour, zero config, zero dependencies. Correct on a single instance.
- **`postgres`** — cross-instance fan-out via **Postgres `LISTEN`/`NOTIFY`**, using the database we *already* require. **No new infrastructure.**
- **`redis`** — opt-in, for deployments that outgrow Postgres NOTIFY's throughput.

Selection is one env var: `EVENT_BUS_BACKEND=memory|postgres|redis` (default `memory`).

The point that makes this worth doing: **the cross-instance problem can be solved without adding any dependency a self-hoster doesn't already have.** This matters because we intend to open-source the platform, and "requires Redis" is exactly the kind of README line that makes people bounce. With this design, the getting-started path stays zero-config single-instance, and scaling out is a one-env-var change backed by Postgres.

---

## 2. Why this exists — the problem, precisely

### 2.1 The in-memory bus

`backend/app/core/event_bus.py` defines `EventBus`: a `publish(event_type, payload, workspace_id)` and a `subscribe(callback, workspace_id, pattern)`, with a module-level singleton `event_bus = EventBus()`. `publish` does a local fan-out — it walks `self._subscribers` (an in-process list), filters by `workspace_id` and `fnmatch(event_type, pattern)`, and `await`s each matching callback. **All subscriber state lives in the process's memory.**

The WS layer consumes it by injection: `ConnectionManager(bus: EventBus)` in `backend/app/services/events/connection_manager.py` calls `self._bus.subscribe(...)` per WS pattern and delivers matched events to the socket via `_deliver`. The singleton is wired once at the bottom of that file: `connection_manager = ConnectionManager(event_bus)`.

### 2.2 The multi-instance failure mode

Two browser tabs, two Cloud Run instances:

```
Tab A ──WS──▶ Instance 1 ──▶ EventBus#1 (in-memory subscribers: tab A)
Tab B ──WS──▶ Instance 2 ──▶ EventBus#2 (in-memory subscribers: tab B)

A card move handled by Instance 1 → published to EventBus#1 → reaches tab A.
                                  → EventBus#2 never hears it → tab B sees nothing
                                    until a manual refetch.
```

This is a **liveness/UX gap, not a correctness bug** (see §3). The symptom is "the kanban needs a full refresh to see a card another tab/runner moved" — the same family of symptom as the already-fixed client-side subscription-drop and slug-vs-UUID scoping bugs, but rooted in the backend this time.

### 2.3 The current workaround and its cost

The live `valaris-backend` service is pinned to **`maxScale=1`** (set manually on the running service; see §7 for the landmine this creates). Consequences:

- **No autoscaling headroom** — every request funnels through one container (`containerConcurrency=80`, `cpu=1`, `memory=512Mi`). Past the concurrency limit, requests queue, then 503.
- **No redundancy** — one OOM/crash/recycle = a brief *full* outage, not a degraded one.
- **`minScale=0`** compounds it for WS specifically: when the instance is reaped on idle, every socket drops and the next request eats a cold start. For a platform meant to push live events, scale-to-zero fights the use case.

The `512Mi` ceiling is the most likely thing to actually bite: WS connections accumulate per-connection memory in one process, and an OOM there is a total outage with no second instance to absorb it.

---

## 3. Critical finding: only WebSockets are at risk under `maxScale > 1`

Before designing the fix, we verified what *else* could break with multiple instances. **Answer: nothing that affects data correctness.** The backend was already built for multiple replicas. Evidence:

| Concurrency-sensitive path | Multi-instance safe? | Mechanism |
|---|---|---|
| **Card reservation** (`next_assignment`, runner claim) — `services/scheduling/assignment_service.py` | ✅ | `UniqueConstraint("card_id", name="uq_agent_reservations_card")` on `agent_reservations` + a `begin_nested()` savepoint around the `INSERT` that catches `IntegrityError` and skips to the next candidate. Two instances racing the same card → one wins the row, the other moves on. No double-assignment. |
| **Merge queue** (`pop_next`) — `repositories/merge_queue.py:81` | ✅ (designed for it) | `SELECT … FOR UPDATE SKIP LOCKED`. The in-code comment explicitly says *"two backend replicas… share the same Postgres table… without a distributed lock."* |
| **All HTTP mutations** | ✅ | Stateless handlers; Postgres is the single source of truth; each request commits its own transaction. |
| **Background loops** `_liveness_loop` + `_merge_queue_loop` (`main.py` startup) | ✅ (idempotent) | Both run on *every* instance under `maxScale>1`, doing some redundant work, but neither corrupts: merge tick is guarded by SKIP LOCKED; liveness is a read-scan that publishes events. |
| **WebSocket event fan-out** (`event_bus.py`) | ❌ **the one gap** | In-memory per-process. This plan fixes exactly this. |

**Conclusion for the team:** lifting `maxScale` today, *without* this change, would not corrupt state — it would only reintroduce occasional cross-instance WS staleness (a tab/runner on instance B missing live events from instance A). So this work is the clean *unlock* for horizontal scaling, not a prerequisite for correctness. (The two background loops doing redundant work under N>1 is benign but worth a follow-up note — see §8.)

---

## 4. The design

### 4.1 Shape: one interface, three backends, picked by env var

The current `EventBus` already *is* the interface — `publish` + `subscribe` + the local fan-out loop. The local fan-out (workspace filter + fnmatch + gather) should be **identical across all backends**. The only thing that varies is **where `publish` sends the event before local delivery happens.**

```
EventBus  (the local fan-out: subscribe registry + publish-to-local-subscribers)
├── (default)         memory   → publish = local fan-out only.            Zero deps.
├── PostgresEventBus  postgres → publish = NOTIFY + local; a LISTEN task  Zero NEW deps.
│                                re-injects remote events into local fan-out.
└── RedisEventBus      redis   → publish = PUBLISH + local; a SUBSCRIBE   Opt-in dep.
                                 task re-injects remote events.
```

Recommended structure (devs to refine):

```python
class EventBus:                    # unchanged = the in-memory default
    async def publish(...): ...    #   local fan-out (keep exactly as today)
    def subscribe(...): ...

class PostgresEventBus(EventBus):  # inherits the ENTIRE fan-out loop
    async def publish(self, event_type, payload, workspace_id):
        await super().publish(event_type, payload, workspace_id)   # local subscribers
        await self._notify(event_type, payload, workspace_id)      # → other instances
    async def _on_notification(self, raw):                          # LISTEN callback
        evt = self._decode(raw)
        await super().publish(evt.event_type, evt.payload, evt.workspace_id)  # local only
        #   ^ but must NOT re-NOTIFY (avoid an echo loop) — see §6.1
```

The key property: `PostgresEventBus` **reuses the inherited subscriber-matching loop unchanged**. It adds only (a) a `NOTIFY` on publish and (b) a background `LISTEN` task that pipes remote notifications back into local fan-out. Estimated ~60–80 new lines for the Postgres adapter. (The `super().publish()` echo concern in `_on_notification` is the one subtlety — see §6.1 for the recommended split into a local-only `_dispatch_local`.)

### 4.2 Factory replaces the bare singleton

```python
def _make_event_bus() -> EventBus:
    backend = os.environ.get("EVENT_BUS_BACKEND", "memory")
    if backend == "postgres":
        return PostgresEventBus(dsn=settings.database_url, channel="valaris_events")
    if backend == "redis":
        return RedisEventBus(url=settings.redis_url, channel="valaris_events")
    return EventBus()

event_bus = _make_event_bus()
```

**Every existing consumer keeps working untouched** — the 17 importers of `event_bus` (services + routers) and `ConnectionManager` all use the same `publish`/`subscribe` surface. The interface does not change.

### 4.3 Why the WS layer needs no changes

`ConnectionManager` already takes the bus by constructor injection and only ever calls `self._bus.subscribe(...)`. A swapped implementation flows through transparently. Per-user notification targeting (`notification.created` → `recipient_user_id`) happens in `_deliver`/`_should_deliver` **after** fan-out, so it is backend-agnostic too. This was verified by reading `connection_manager.py` end-to-end.

### 4.4 The Postgres transport, concretely

- **Driver:** `asyncpg` is already a dependency. Use a dedicated connection with `connection.add_listener(channel, callback)` for the LISTEN side, and `await conn.execute("SELECT pg_notify($1, $2)", channel, payload_json)` (or `NOTIFY`) for the publish side. **No new pip package.**
- **Lifecycle:** the LISTEN connection is long-lived, opened in the app `startup` (alongside `_liveness_loop`/`_merge_queue_loop`) and closed in `shutdown`. It must **auto-reconnect** — a dropped LISTEN connection silently stops all cross-instance delivery (see §6.2).
- **Payload:** serialize `{event_type, workspace_id, payload, timestamp, event_id}` to JSON. See §6.3 for the 8KB `NOTIFY` payload limit and the mitigation.

---

## 5. The open-source framing (why this shape, not just "add Redis")

This is the design constraint that drove the whole plan, so it's stated explicitly for reviewers:

> **The EventBus is pluggable. In-memory is the zero-config default and runs the whole platform on one instance. To scale horizontally, set `EVENT_BUS_BACKEND=postgres` — it fans events across instances using the database you already run. No Redis, no message broker, no extra infrastructure.**

Consequences worth preserving through implementation:

- The **getting-started path stays at zero dependencies.** A self-hoster runs one instance, in-memory, and everything works.
- **`maxScale=1` stops being a workaround to apologize for** — it becomes the *documented default deployment profile* ("simple, single-instance, no moving parts"), with a clean, dependency-free upgrade path already in the codebase.
- **Redis remains in the tree for credibility, not as a requirement** — it signals "yes, this scales to serious load" for the small minority who outgrow Postgres NOTIFY, without imposing itself on everyone else.

This is the same spirit as Django's `CACHES`, Celery's broker selection, and Django Channels' `CHANNEL_LAYERS` (in-memory default → Redis for prod). It also extends the provider-agnostic abstraction direction the platform already took for GitHub/Claude — the EventBus becomes a real, swappable seam.

---

## 6. Risks, edge cases, and things for devs to scrutinize

### 6.1 Echo loop (must-fix design point)
`PostgresEventBus.publish` does local fan-out **and** `NOTIFY`. The LISTEN callback that receives a remote event must do **local fan-out only** — if it called the full `publish`, it would re-`NOTIFY` and loop forever. Recommended: factor the local-only path into a `_dispatch_local(event)` that both `publish` (after NOTIFY) and `_on_notification` call, so neither re-emits. **Each instance must also ignore its own NOTIFYs** so a locally-published event isn't delivered twice (once locally, once via its own LISTEN echo) — tag the payload with a per-process `origin_id` and skip on match.

### 6.2 LISTEN connection durability
A silently-dropped LISTEN connection = cross-instance delivery stops with no error surfaced. Needs: auto-reconnect with backoff, and ideally a healthcheck/metric on "listener connected." This is the single most important operational concern.

### 6.3 `NOTIFY` 8KB payload limit
Postgres caps `NOTIFY` payloads at ~8000 bytes. Our event envelopes are small (ids, action, changes-diff, board_id), so most fit — **but `after_state`/`before_state` full-entity snapshots can exceed it.** Two options for devs to choose:
- **(a) Send a thin notification** (event_type + entity ids + workspace_id) over NOTIFY and let each instance's subscribers read current state from the DB/cache. Robust, slightly more DB load.
- **(b) Send the full envelope but cap/strip oversized snapshot fields**, falling back to (a)'s thin form when over the limit.
Recommend (a) as the safe default; it also sidesteps stale-snapshot races.

### 6.4 Delivery semantics
`LISTEN`/`NOTIFY` is **at-most-once and not durable** — if no instance is listening at NOTIFY time, the event is lost. This matches today's in-memory semantics (events are ephemeral; the source of truth is Postgres and clients refetch). Acceptable, but state it in the contract so no one assumes durability. If durable delivery is ever needed, that's the Redis-streams/Pub-Sub tier or an outbox table — explicitly out of scope here.

### 6.5 Ordering
`NOTIFY` ordering is per-connection FIFO but there's no global ordering guarantee across publishers. The frontend reconciler already tolerates out-of-order/duplicate events (no-op guard + debounced refetch), so this is fine — but confirm against the client contract.

### 6.6 Notification per-user targeting
`notification.created` carries `recipient_user_id` and is filtered at delivery in `ConnectionManager._should_deliver`. Since that filter runs *after* fan-out on the receiving instance, it works identically under the Postgres backend — **verify with a test** that a notification published on instance A reaches only the right user's socket on instance B.

### 6.7 Test strategy (TDD, per project convention)
- **Backend abstraction tests** against the `memory` backend: behaviour unchanged (regression guard for all 17 consumers).
- **`PostgresEventBus` tests**: the integration suite uses in-process SQLite (aiosqlite), which has **no LISTEN/NOTIFY** — so the Postgres adapter needs either a real-Postgres test lane (testcontainers / a CI Postgres service) or a transport-level fake that exercises the encode/decode + echo-suppression + local-dispatch logic without a live DB. Devs to decide; flag that the existing SQLite test harness cannot cover the transport.
- **Two-bus test**: instantiate two `PostgresEventBus` instances against the same DB, publish on one, assert the other's subscriber fires (echo-suppressed, no double-delivery on the publisher).

---

## 7. ⚠️ Deploy-config landmine — RESOLVED 2026-07-23

> **Update (2026-07-23):** This landmine fired exactly as predicted, then was permanently closed. During the prod-outage hotfix deploys on 2026-07-23, `make deploy-backend` reset the hand-set `maxScale=1` back to `2` while the service was still on the `memory` bus — momentarily reintroducing cross-instance WS split-brain. It was re-pinned the same day. It is now **permanently closed** by `EVENT_BUS_BACKEND=postgres` landing *inside* `cloudbuild.yaml` itself (the enablement change, alongside the implementation in commit `93d2877`, PR #14): the deploy config now ships the postgres bus and `--max-instances=2` together, so a deploy can no longer raise `maxScale` above what the bus supports. The drift between hand-set live config and deploy config is gone.

The original finding, retained for the record — the live service ran `maxScale=1`, but **the deploy config did not**:

- `cloudbuild.yaml:119` → `--max-instances=2`
- `cloudbuild.yaml:147` → `--max-instances=2` (frontend)
- `infra/setup.sh:153` / `:166` → `--max-instances=2`

**The live `maxScale=1` was set by hand on the running service. The next `make deploy-backend` will reset it to `2` and silently reintroduce the WS split-brain.** Until the Postgres backend landed and was enabled, whoever owned deploys had to either:
- pin `--max-instances=1` in `cloudbuild.yaml`/`infra/setup.sh`, **or**
- re-apply `gcloud run services update valaris-backend --region=us-central1 --max-instances=1` after every deploy.

Once `EVENT_BUS_BACKEND=postgres` was live and verified, `--max-instances` was raised back to ≥2 in the deploy config in the *same* change that enabled the backend, so the two never drift. This is the state now in effect.

Original live resource config for reference (`valaris-backend`, rev `-00091-fm4`): `minScale=0, maxScale=1, cpu=1, memory=512Mi, concurrency=80, timeout=300s, cpu-boost=true`.

---

## 8. Recommended sequencing

1. **Now / ops (independent, ~5 min):** de-risk the single instance we depend on today — bump `memory 512Mi→1Gi` and `minScale 0→1` (kills OOM risk + cold-start socket-reaping). Pure ops, no code, no relation to the broker work. *(Decision pending with the platform owner.)*
2. **Build (this plan):** extract the `EventBus` interface (no behaviour change to `memory`), add `PostgresEventBus`, add the factory + `EVENT_BUS_BACKEND` env var. Strict TDD. Keep `memory` as default.
3. **Enable + scale:** set `EVENT_BUS_BACKEND=postgres` in the backend service env, verify cross-instance delivery on a 2-instance revision, then raise `--max-instances` back to ≥2 in `cloudbuild.yaml`/`infra/setup.sh` in the same change (closing the §7 drift).
4. **Follow-ups (separate cards):** (a) `redis` adapter for the scale tier; (b) decide whether the `_liveness_loop`/`_merge_queue_loop` background loops should run on *all* instances or be elected to one (they're safe on all, but redundant — a `minScale=1`-only leader election or a "run loops only if instance index 0" guard would cut wasted ticks); (c) listener-connected healthcheck/metric (§6.2).

---

## 9. What this plan deliberately does NOT do

- It does not add Redis to the required dependency set. Redis is an opt-in third adapter only.
- It does not change the event envelope, the WS client contract, or any of the 17 `event_bus` consumers' call sites.
- It does not add durability/replay. Events stay ephemeral; Postgres remains the source of truth and clients refetch — same as today.
- It does not change `ConnectionManager` or the per-user notification targeting.

---

## 10. Source references (read these first)

- `backend/app/core/event_bus.py` — the bus + singleton (the whole surface to refactor; ~90 lines).
- `backend/app/services/events/connection_manager.py` — WS consumer; takes the bus by injection (why the WS layer needs no change).
- `backend/app/services/scheduling/assignment_service.py:230-245` — reservation `INSERT` + `IntegrityError` skip; `:60` `RESERVATION_TTL_SECONDS`.
- `backend/app/models/agents/reservation.py:25` — `uq_agent_reservations_card` (the constraint that makes reservation multi-instance-safe).
- `backend/app/repositories/merge_queue.py:60-81` — `pop_next` with `FOR UPDATE SKIP LOCKED` (proof the merge queue was built for replicas).
- `backend/app/main.py:153-223` — startup background loops + tick intervals.
- `cloudbuild.yaml:118-149`, `infra/setup.sh:152-167` — the `--max-instances=2` lines that contradict the live `maxScale=1` (§7).
- `docs/events.md` — existing event/WS documentation to keep consistent with.
