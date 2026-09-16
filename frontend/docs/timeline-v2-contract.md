# Board Timeline Simulator — V2 "Step Clarity" Contract

Builds on the shipped v1.1 simulator (`features/timeline/`). Three user-driven
goals, decoupled and additive. Both engine and UI build against THIS doc.

## Goals (user, 2026-06-08)

1. **Event → card binding.** When the current step acts on (or references) a
   specific card, that card lights up: **glow + ring always; a particle burst
   ADDITIONALLY during active Play; reduced-motion → static ring only.** Color
   keyed to the action (create=success, move=info, update=warning, delete=destructive).
2. **Off-board events.** Steps that don't change a board card (notes,
   dependencies, board edits, generic MCP calls) get a rich **icon badge in the
   step panel** + a soft **edge light-sweep** on the board. If such an event
   *references* a card id, that card ALSO glows.
3. **Minimal "squares" view.** A toggle between the rich cards and a **very
   compact tile** (small trimmed title + type color + priority + one holder)
   so many cards fit at once. Toggle persists in localStorage.
4. **Rich step panel.** Replace the bare caption string with a structured,
   UX-rich representation of *what happened this step* — icon, action verb,
   entity, and event-specific detail (move from→to, dependency a→b, changed
   fields) — while keeping the fine-grained text.

## Non-negotiables (carried from v1)

- ROLE-AGNOSTIC: never enumerate card_type / priority / status / role / action.
  Any user-defined value must render. Action→color/icon maps fall back to a
  NEUTRAL token for unknown actions; entity titles come from snapshots.
- Pure logic in `utils/` (no React/clock/IO), tested in isolation. The wall
  clock only enters via existing param-passing (endTime) and the playback hook.
- Reuse ONLY visual tokens, never the live KanbanCard/CardDetailSheet.
- i18n exact parity across every locale in `src/i18n/supported-languages.ts`
  (currently `en`, `es`, and `pt-BR`). tsc -b --force clean. eslint 0. CI=true tooling.
- Additive: no change to v1 engine/analytics/types' existing fields or behavior.
  All new exports are NEW symbols. Existing tests stay green.

## CORNERSTONE primitive — `describeEvent` (pure)

`utils/event-descriptor.ts`. Every other V2 piece consumes its output.

```ts
export type StepKind =
  | "card-create" | "card-move" | "card-update" | "card-delete"
  | "dependency" | "note" | "board" | "column" | "other";

export interface StepDescriptor {
  kind: StepKind;
  // The board card this step spotlights, if any. For entity_type:"card" it's
  // entity_id. For other entities, a card id discovered in changes/snapshot
  // (e.g. dependency edges reference card ids) — else null.
  targetCardId: string | null;
  // A SECONDARY card id for relational events (dependency to/source), else null.
  relatedCardId: string | null;
  // Whether this step structurally changes a board card (drives "should the
  // board animate vs only edge-pulse"). true for card create/move/update/delete.
  touchesBoard: boolean;
  // Token name (NOT a literal color) for the accent, action-keyed. One of:
  //   "--color-success" | "--color-info" | "--color-warning"
  //   | "--color-destructive" | "--color-data-4" | "--color-muted-foreground"
  accentToken: string;
  // lucide icon NAME (string) the UI maps to a component. Role-agnostic set:
  //   "Plus" | "MoveRight" | "Pencil" | "Trash2" | "Link2" | "StickyNote"
  //   | "LayoutGrid" | "Columns3" | "Activity"
  iconName: string;
  // Structured detail for the rich panel; all optional, all role-agnostic.
  detail: {
    fromColumnId?: string | null;
    toColumnId?: string | null;
    changedFields?: string[];   // from changes keys, humanized by the UI
    fromCardId?: string | null; // dependency edge
    toCardId?: string | null;   // dependency edge
  };
}

export function describeEvent(event: TimelineEvent): StepDescriptor;
```

### Classification rules (deterministic, role-agnostic)

- `entity_type === "card"`:
  - action `created` → kind `card-create`, accent `--color-success`, icon `Plus`
  - action `moved` → kind `card-move`, accent `--color-info`, icon `MoveRight`,
    detail.from/toColumnId from `after_state.column_id` / `changes.column_id`
  - action `deleted` → kind `card-delete`, accent `--color-destructive`, icon `Trash2`
  - any other action (incl. `updated` and unknown) → kind `card-update`,
    accent `--color-warning`, icon `Pencil`, detail.changedFields = keys of
    `changes` (minus internal keys). targetCardId = entity_id; touchesBoard=true.
- `entity_type === "column"` → kind `column`, accent `--color-data-4`,
  icon `Columns3`, touchesBoard=false (lanes are stable in the replay).
- `entity_type === "board"` → kind `board`, accent `--color-data-4`,
  icon `LayoutGrid`, touchesBoard=false.
- `entity_type === "note"` → kind `note`, accent `--color-muted-foreground`,
  icon `StickyNote`, touchesBoard=false.
- dependency actions: the existing Activity action union has no "dependency_*",
  but the backend emits `dependency_added/removed/replaced` as the `action`
  string on `entity_type:"card"`. Detect by `action.startsWith("dependency")`
  → kind `dependency`, accent `--color-info`, icon `Link2`, touchesBoard=false
  (a dependency edge doesn't move the card on the board). targetCardId = the
  card the edge is anchored on (entity_id); relatedCardId / detail.from/toCardId
  parsed from `changes` if present (`depends_on`, `blocks`, `from`, `to` keys —
  pass through whatever string ids exist; never invent).
- everything else → kind `other`, accent `--color-muted-foreground`, icon `Activity`.

A step `touchesBoard=false` with a non-null targetCardId STILL spotlights that
card (e.g. a dependency added to a visible card) — `touchesBoard` only gates the
"did a card structurally change" reasoning, not whether to glow.

## Spotlight engine — `useSpotlight` + presentational

- `hooks/use-spotlight.ts`: given `(descriptor, playing, reducedMotion)` returns
  a `spotlight` object `{ cardId: string|null, accentToken, burst: boolean }`
  where `burst = playing && !reducedMotion && descriptor.touchesBoard-or-targets-a-card`.
  Also exposes the targetCardId for auto-scroll. Keep the hook thin; the
  decision of WHEN to burst is pure and unit-tested via a helper
  `shouldBurst(descriptor, playing, reducedMotion): boolean`.
- ReplayCard gains optional props: `spotlight?: { active: boolean; accentToken: string; burst: boolean }`.
  - active → glow + ring (CSS box-shadow + ring, animated pulse ~2 cycles).
    Reduced-motion → static ring (no pulse animation).
  - burst → render a `<ParticleBurst accentToken/>` overlay (absolute, pointer-
    events-none) that self-removes. Particle layer is pure-CSS/transform, no deps.
  - The accent uses `color-mix(in oklab, var(<accentToken>) X%, transparent)`.
- Auto-scroll: ReplayColumn/Board scrolls the spotlighted card into view
  (`scrollIntoView({ block:"nearest", inline:"nearest" })`, behavior respects
  reduced-motion → "auto" else "smooth"). Guard so it only fires when the
  spotlight cardId changes (not every render).

## Off-board edge pulse — `BoardEdgePulse`

- A presentational overlay on ReplayBoard: when the current descriptor has
  `touchesBoard === false` AND kind !== "column" (column lanes are part of the
  board chrome), render a soft animated light sweep along the board's top edge,
  tinted with the descriptor's accentToken. Self-fades. Reduced-motion → a
  static thin accent line on the edge for one frame (no sweep animation).
- Keyed on the current event id so each step re-triggers the sweep.

## Square / compact view — `ReplayCardSquare` + view toggle

- `ReplayCardSquare`: a VERY compact tile. Small trimmed title (1 line, ellipsis,
  ~0.7rem), card-type tint as a left bar or fill, a priority dot, ONE holder
  avatar (tiny) with +N overflow as a number. Full title via `title=`/tooltip.
  Same click-to-select + keyboard (Enter/Space) + `data-replay-card` as the rich
  card. Same motion `layout`/`layoutId` glide + AnimatePresence so toggling view
  keeps animation. Same spotlight props (glow/ring/burst) as the rich card.
- ViewMode `"rich" | "compact"`, persisted in `localStorage` key
  `timeline-view-mode` (default "rich"). A small segmented toggle in the
  transport/header row. ReplayColumn renders rich or square per mode; in compact
  mode the column body is a wrap grid (`flex flex-wrap` / grid) so many tiles
  share rows. Column width may widen in compact mode to fit a few columns of tiles.

## Rich step panel — `StepPanel`

Replaces the plain caption block in TransportControls' right side (or a new row).
Given the current `descriptor`, event, columnNames, and `t`:
- icon (from iconName) in an accent-tinted chip + the action verb label
  (i18n key `timeline.step.kind.<kind>`, role-agnostic; unknown action falls to
  the humanized action string) + the entity title.
- event-specific secondary line:
  - move → `from → to` column names (resolve via columnNames).
  - dependency → `<thisCard> ↔ <relatedCard>` titles if resolvable, else ids.
  - update → a compact list of humanized changed fields (chips).
  - note/board/other → the backend `summary` verbatim (it's already a sentence).
- keep the absolute timestamp + the fine-grained `deriveCaption` text as a
  subtitle so NO information is lost.
- Pure rendering; all label resolution via existing helpers + new i18n keys.

## i18n keys to ADD (every registered locale, exact parity)

```text
timeline.view.rich
timeline.view.compact
timeline.view.toggleLabel
timeline.step.kind.card-create
timeline.step.kind.card-move
timeline.step.kind.card-update
timeline.step.kind.card-delete
timeline.step.kind.dependency
timeline.step.kind.note
timeline.step.kind.board
timeline.step.kind.column
timeline.step.kind.other
timeline.step.changedFields
timeline.step.dependencyEdge
timeline.step.offBoardHint
```

Canonical copy lives in every catalog registered by
`src/i18n/supported-languages.ts`; do not duplicate localized values in this
contract. Add any additional builder keys to every registered locale and keep
placeholder parity.

## Test surface (TDD — RED first)

- `event-descriptor.test.ts`: each entity_type/action → correct kind, accent,
  icon, targetCardId, touchesBoard, detail. Unknown action → card-update.
  Unknown entity → other. dependency_* detection. relatedCardId parsing.
- `use-spotlight` / `shouldBurst.test.ts`: burst only when playing && !reduced
  && (touchesBoard || targetCardId); active glow whenever targetCardId set;
  reduced-motion never bursts.
- `ReplayCardSquare.test.tsx`: renders title (or untitled), holder, click selects,
  keyboard selects, spotlight ring class applied when active.
- `StepPanel.test.tsx`: move shows from→to; update shows changed-field chips;
  dependency shows edge; note shows summary; keeps timestamp + caption.
- View-toggle: persists to localStorage, renders square vs rich.
- All existing timeline tests MUST stay green.
