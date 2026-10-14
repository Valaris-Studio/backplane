# Board Timeline Simulator — Current Contract (v2)

The [v2 generation-scoped contract](#v2--generation-scoped-windowed-history-2026-10-08)
is authoritative for the current frontend and backend. The v1 sections below are
retained only for backward compatibility with the existing `/timeline` endpoint;
their live-baseline replay rules do not apply to v2. Update this shared contract
when producer or consumer behavior changes.

## v1.1 addendum — current-state baseline (makes legacy boards useful)

Pre-migration activity has null snapshots, so a pure event-fold renders existing
boards as "Untitled cards in an Unknown column." Fix: the endpoint ALSO returns
the board's CURRENT state as a `baseline`, and the engine SEEDS from it before
folding events.

- Response gains: `"baseline": { "columns": ColumnSnapshot[], "cards": CardSnapshot[] } | null`
  — the board's live columns + cards (reuse the existing board-detail eager load:
  columns ordered by position, each card with participants→user/agent loaded;
  build via the SAME `snapshot_column`/`snapshot_card` helpers). `null` only if
  the board has no detail (shouldn't happen for a real board).
- Engine: `reconstructState(events, frameIndex, baseline?)`. When `baseline` is
  given, seed the `columns` map from `baseline.columns` and the `cards` map from
  `baseline.cards` (legacy:false) BEFORE folding. Then fold events[0..frameIndex]
  exactly as before (enriched events override identity/position; a legacy
  null-snapshot card event leaves the seeded baseline card in place — do NOT
  synthesize an Untitled card when the id already exists from baseline; only
  synthesize for a truly-unknown id). A card `deleted` event still removes it.
  Result: real titles/columns/participants always; positions refine as enriched
  events accumulate. `partial` still set true when any legacy event was applied,
  so the UI can show a "limited history before <deploy>" note.
- Backward compatible: `baseline` optional in the type; calling reconstructState
  WITHOUT a baseline behaves exactly as v1 (all existing engine tests stay green).
- analytics: unchanged signature; dwell/holders still derive from events. (A
  legacy-only card has no column-changing events → dwell may be empty; that's
  honest. Optionally seed the open dwell segment from baseline column at the
  board's first event time — only if it stays pure and tested. Keep simple if
  unsure.)

## Endpoint

```
GET /api/workspaces/{slug}/boards/{board_id}/timeline
```

Returns the FULL board activity log ordered ASCending by `created_at`
(oldest → newest), each enriched with state snapshots. One bounded call.

- Auth: same workspace-membership dependency as the history endpoint.
- Bound: cap at a high sane limit (e.g. 5000 events). If a board exceeds it,
  return the OLDEST 5000 and include `truncated: true` so the UI can say so.
  (log/surface the cap — never silently drop. Most boards are far under.)
- Ordering: ASC so the FE can fold events forward to reconstruct any frame.

### Response shape

```jsonc
{
  "board_id": "uuid",
  "generated_at": "2026-06-08T12:00:00Z",
  "truncated": false,
  "events": [ TimelineEvent, ... ]   // ASC by created_at
}
```

### TimelineEvent

Extends the existing ActivityRead with two nullable snapshot fields.

```jsonc
{
  "id": "uuid",
  "entity_type": "card" | "column" | "board" | ...,
  "entity_id": "uuid",
  "action": "created" | "updated" | "moved" | "deleted" | "dependency_added" | ...,
  "actor_id": "uuid",
  "actor_name": "string | null",
  "actor_email": "string | null",
  "agent_id": "uuid | null",
  "summary": "string",
  "changes": { ... } | null,        // existing field, unchanged
  "before_state": { ... } | null,   // NEW — entity state BEFORE this event
  "after_state": { ... } | null,    // NEW — entity state AFTER this event
  "created_at": "2026-06-08T...Z"
}
```

### Snapshot shapes (`before_state` / `after_state`)

Snapshots are the MINIMAL fields needed to render + reconstruct. Role-agnostic:
participants carry whatever role string exists — never an enumerated set.

For `entity_type: "card"`:
```jsonc
{
  "id": "uuid",
  "title": "string",
  "card_type": "string",      // opaque — do not enumerate
  "priority": "string",       // opaque
  "column_id": "uuid | null",
  "position": 1024.0,
  "status": "string | null",
  "labels": ["string"] | null,
  "participants": [            // role-agnostic
    { "user_id": "uuid", "agent_id": "uuid | null", "name": "string",
      "role": "string", "avatar_url": "string | null" }
  ]
}
```
- `created` card: `before_state = null`, `after_state = {full card snapshot}`.
- `updated` card: both present; differ only in changed fields. (Also keep
  `changes` for a quick field list, but snapshots are the source of truth.)
- `moved` card: both present; `column_id` (and `position`) differ.
- `deleted` card: `before_state = {final snapshot}`, `after_state = null`.

For `entity_type: "column"`:
```jsonc
{ "id": "uuid", "name": "string", "column_type": "string | null", "position": 1024.0 }
```
- created → after only; deleted → before only; updated/reordered → both.

Old activities (pre-migration) have `before_state = after_state = null`. The FE
engine treats those best-effort (see below).

## Frontend reconstruction semantics

`reconstructState(events, frameIndex)` folds events[0..frameIndex] forward:
- card `created`/`updated`/`moved` → upsert card from `after_state`.
- card `deleted` → remove card.
- column `created`/`updated`/`moved`(reorder) → upsert column from `after_state`.
- column `deleted` → remove column.
- Events with null snapshots (legacy) → best-effort: a `created` with no
  snapshot places the card in an "Unknown" holding area; a `moved` with `changes`
  still works (column_id.old/new). Surface a small "partial history" note when
  any legacy event is encountered.

Per-card analytics (derived purely on the client from the same events):
- dwell-per-column: sum of time the card spent in each column between moves.
- holders: from participant snapshots over time — who held it (any role) + for
  how long. Role strings are passed through verbatim.

## Non-negotiables
- Additive + nullable everywhere (migration-safe; rolling deploy).
- No change to existing activity/history behavior or response (only ADD fields).
- FE: new `features/timeline/` module; reuse ONLY visual tokens from kanban,
  never the live KanbanCard/CardDetailSheet (they mutate + use dnd).
- i18n exact parity across every locale in `src/i18n/supported-languages.ts`
  (currently `en`, `es`, and `pt-BR`). TDD. tsc -b --force clean. CI=true tooling.

## v2 — generation-scoped, windowed history (2026-10-08)

The v1 `/timeline` endpoint above remains unchanged for rolling compatibility.
The additive APIs below live under
`/api/workspaces/{slug}/boards/{board_id}/timeline`. v2 preserves source `seq`
order (the shipped v1 implementation already uses `seq`, not `created_at`).
All sequence values and counts are unsigned decimal **strings**, never JSON
numbers; PostgreSQL BIGINT can exceed JavaScript's safe integer range. IDs are
UUID strings; timestamps are UTC ISO 8601. Empty bounds are null.

### Frozen response types

```ts
type Seq = string;
type Coverage = {
  quality: "reconstructed" | "partial";
  unknown_origin: boolean;
  missing_structural_snapshots: string;
  reasons: Array<"unknown_origin" | "missing_structural_snapshot" | "conflicting_snapshot">;
};
type ReplayState = { columns: ColumnSnapshot[]; cards: CardSnapshot[] };
type Anchor = { through_seq: Seq | null; state: ReplayState; coverage: Coverage };
type Generation = {
  id: string; board_id: string; created_at: string; expires_at: string;
  first_seq: Seq | null; head_seq: Seq | null; event_count: string;
};
type Overview = {
  generation_id: string; first_seq: Seq | null; head_seq: Seq | null;
  first_at: string | null; last_at: string | null; event_count: string;
  buckets: Array<{
    start_at: string; end_at: string; count: string;
    first_seq: Seq | null; last_seq: Seq | null;
  }>;
};
type WindowReady = {
  status: "ready"; generation_id: string; anchor: Anchor;
  events: Array<TimelineEvent & { seq: Seq }>;
  window: {
    first_seq: Seq | null; last_seq: Seq | null;
    previous_cursor: string | null; next_cursor: string | null;
  };
  coverage: Coverage; // after the final returned event; anchor carries starting coverage
};
type Preparation = {
  status: "preparing" | "failed"; generation_id: string; preparation_id: string;
  progress: { through_seq: Seq | null; target_seq: Seq | null; processed_events: string };
  retryable: boolean;
  error: { code: string; message: string } | null;
};
type LiveHead = {
  generation_id: string; observed_at: string; head_seq: Seq | null;
  state: ReplayState; // observed in the generation transaction; NEVER a replay anchor
};
type SearchPage = {
  generation_id: string; scope: "generation";
  matches: Array<{ id: string; seq: Seq; created_at: string; summary: string }>;
  next_cursor: string | null;
};
```

`ColumnSnapshot` and `CardSnapshot` retain the existing shapes; `created_at` on
cards remains optional for old snapshots. Snapshot fields are evidenced values,
not enriched from today's entities. Missing entity state is omitted from the
known subset, not asserted nonexistent. Reasons are unique members of the fixed
enum (at most three); no unbounded gap list enters a response. Reconstructed
means derived from recorded evidence, not a claim of an externally observable
committed intermediate database state.

### Endpoints and navigation

- `POST /generations` with `{ "request_id": "uuid" }` establishes a generation.
  Return `Generation` with 201; an authorized repeat of that request ID on the
  same board returns the same generation with 200. Refresh uses a new request ID.
  A reused key never grants access to another board/workspace. Expired keys return
  410 rather than silently changing the generation behind a retry.
- `GET /generations/{id}` returns generation metadata, reauthorizing membership.
- `GET /generations/{id}/overview?buckets=128` returns `Overview`; accept 1–256
  buckets. Counts/span cover the entire retained generation, not just the detail
  window. Empty history has null temporal/sequence bounds and empty buckets;
  single-timestamp history produces one nonempty bucket with valid boundaries.
  Zero buckets, if emitted, have null sequence bounds. No state JSON is read or
  returned for overview aggregation.
- `GET /generations/{id}/window?limit=200` opens the most recent bounded window.
  Accept limits 1–500. Alternatively specify exactly one of `at_seq`, `at_time`,
  or opaque `cursor`. A seek includes its target (first sequence at/after
  `at_seq`, or the nearest timestamp with sequence tie-break), then a contiguous
  source-order neighborhood. A target outside retained bounds clamps to the
  earliest/latest event. Cursor navigation returns disjoint adjoining windows;
  events are always ascending. Time selection locates a sequence neighborhood:
  **never filter structural replay events out solely by their timestamp**.
  Return `WindowReady` (200), `Preparation` preparing (202), or failed (200).
  The anchor is the state through the event immediately preceding the returned
  window, exclusive of its first event. Empty history has an empty event array,
  null window bounds/cursors and unknown-origin anchor. Repeated reads of an
  unchanged generation/selector address the same preparation work.
- `POST /generations/{id}/preparations/{preparation_id}/retry` idempotently queues
  retryable work and returns `Preparation`. Progress gives actual completed work,
  not a fabricated percentage. Existing event-bus invalidation wakes readers;
  missed invalidation is recoverable by reading the same window again.
- `GET /generations/{id}/live-head` returns `LiveHead`. It is separately labeled
  observed board state, not the last ordinary replay page and not a fold seed.
- `GET /generations/{id}/search?q=...&limit=50&cursor=...` returns `SearchPage`;
  limit 1–100, nonblank query at most 200 characters. Search matches recorded
  event summaries across this generation, case-insensitively; it never searches
  today's card title or removes events from replay. Local actor/text flags are
  explicitly labeled **this window**. Selecting a global match seeks its seq.

Malformed selectors/cursors return 422; expired generation references return
410; foreign-board/generation/cursor/preparation references return 404 without
metadata. Nonmembers receive the existing 403 membership response. Every read
and retry reauthorizes; a cursor is navigation data, not authorization. A cursor
is bound to generation, board, and endpoint purpose; never an offset or a raw
unvalidated client sequence disguised as a cursor.

History event response size is bounded by these page limits. State size scales
with evidenced board state, not event count; do not multiply a full state per
returned event. The browser retains a bounded number of windows. Existing v1
baseline/no-time-travel heuristics do not apply to v2.

### Consistency, checkpoints and coverage

Establish a generation in a fresh, owned REPEATABLE READ transaction **before
any reads, including authorization**. Capture database visibility, source bounds
and the separately observed board together. Add nullable PG16 `xid8` activity
transaction provenance, then set the server default `pg_current_xact_id()`;
existing rows stay null and old writers that omit the field receive provenance.
Later reads filter `pg_visible_in_snapshot` against the stored generation
snapshot, together with board scope and sequence boundaries. A lower sequence
committed late must not enter an existing generation; refresh includes it.
Never derive a stable visibility boundary from max(seq) alone or event-bus order.

The pure service seam is
`app.services.timeline_replay.fold_events(events, initial_state=None,
initial_coverage=None) -> {state, coverage}`. Inputs/outputs are plain dictionaries;
no I/O, clock, live baseline, or mutation of caller-owned values. Default genesis
is empty evidenced state with unknown_origin=true, partial quality, count "0",
and reason unknown_origin. Known-empty genesis requires explicit supported
capture provenance; a recent creation date is not proof. Full after-snapshots
establish entity state prospectively. Missing structural evidence invalidates
that entity's previously evidenced state and increments the decimal counter.
An incomplete snapshot is missing evidence; a wrong entity ID is conflicting
snapshot evidence and may never materialize the foreign entity. A known
before-state mismatch marks conflict but a complete after-state still establishes
prospective state. Nonstructural dependency actions do not degrade coverage.
Deletion establishes absence; column cascade semantics remove its known cards.
Coverage reasons/counts are cumulative source evidence, even if a later full
snapshot restores individual entity knowledge. quality is partial when any reason
remains; otherwise reconstructed. Never fill earlier frames from later evidence.

A checkpoint is exactly fold(genesis, generation-visible prefix, engine version).
Reuse requires equal genesis/schema and an unchanged visible prefix. Newly
visible events before its boundary invalidate it; later events do not. Persist
sparse checkpoints and resumable bounded preparation batches. Cold seeks may
need server work but must return preparation status rather than perform an
unbounded HTTP fold. Checkpoint work owns its transaction and is idempotent.

Transaction provenance is cluster-history-specific. The supported logical
restore flow normalizes restored provenance to null and expires generations,
checkpoints and preparation work atomically after pg_restore and before startup.
Source activity is preserved. The normalization is idempotent and older-dump
tolerant. Restore implementation/documentation composition belongs to the root
integration owner, not a second restore framework.

Known-empty genesis provenance is `changes.timeline_genesis =
{"version":1,"known_empty":true}` on the board-created activity. Default-column
activities can precede that row in the SAME recorded transaction. The generation
resolver applies this marker to the start of the complete creation transaction,
not as a later reset that erases those columns. Missing/unsupported markers stay
unknown; no inference from dates. The pure fold receives the resolved explicit
initial coverage and does not need to inspect later events for genesis.


### Storage, expiry and display bounds

Generations expire after 24 hours. Expiration removes derived checkpoints,
preparation work and heavy observations, while retaining the request identity so
an expired establishment retry returns 410. Activity itself is retained; opening
a new generation restores access to its retained history.

Each generation stores at most 64 checkpoints. Saving progress retains its
just-written boundary and the highest 63 other sequence boundaries. Short inline
seeks normally return an ephemeral anchor instead of saving one full board per
scrubbed event. Background work resumes from actual retained evidence; an evicted
anchor can require bounded preparation again, including for a previously ready
window. Shorter target prefixes run first, so later targets may wait.

Limits bound event counts: up to 500 events per window, 200 replay events for an
inline prefix, and up to 500 per background batch (250 by default). They do not
promise an absolute byte ceiling. A source event can be large; anchor state
scales with evidenced board size. Overview aggregation does not load activity
snapshots or the separately captured live-board observation.

Actor names are labels observed during generation creation and remain frozen
within that generation; they are not claims about names at the event's original
time. Immutable `principal_key` supplies agent identity when recorded. A legacy
`agent_id` foreign key remains a best-effort fallback and can disappear when its
agent is deleted. Missing provenance never establishes that an actor was human.
Source snapshot state is not enriched with current actor or entity data.
