# Board Timeline Simulator — Frozen Contract (v1.1)

This is the API/data contract shared by the backend (producer) and frontend
(consumer). Both sides build against THIS. Do not diverge without updating here.

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
