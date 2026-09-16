# @Mention System — Phase-0 Contract (FROZEN)

> Producer for the reserved `mention` notification category. Consistent, reusable
> mention capability across card descriptions and notes today; any future TipTap
> text field adopts it by adding one editor extension. Builds on the per-user
> notification system (`docs/notification-system-contract.md`) — that contract's
> INV-1..INV-6 and its generation pipeline are load-bearing here and are NOT
> re-specified, only referenced.

## 0. Decisions locked (user sign-off 2026-06-14)

1. **Storage = TipTap `mention` node** (structured PM-JSON inline atom), NOT an
   in-text token, NOT a side-table. The content JSON is the single source of
   truth for *who was mentioned*. Backend resolves mentioned users by walking
   the ProseMirror doc tree at save-time — never a regex over serialized text.
2. **Re-add stays silent.** dedupe key is entity-scoped (`entity_id:user_id`);
   once a user has been notified of being mentioned in a given card/note,
   removing and re-adding them never re-fires. (INV-6, the non-spammy reading.)
3. **Mentionable set = workspace members only.** The autocomplete is sourced from
   the existing members endpoint, extended with an optional `?q=` search filter.

## 1. Storage format

A mention is a ProseMirror inline **atom node** inside the existing TipTap
content (`card.description` and `note.content` are both PM-JSON today):

```json
{ "type": "mention", "attrs": { "id": "<user-uuid>", "label": "Alice Adams" } }
```

- `attrs.id` — the mentioned user's `users.id` (UUID string). The authoritative key.
- `attrs.label` — display name at mention-time (a denormalized convenience for
  render; the backend NEVER trusts it for identity, only `id`).
- Atom node ⇒ no partial edit, no mid-word corruption, deletes whole, survives
  copy/paste as a unit. XSS-safe: rendered by a React node-view, never raw HTML.

**Why not the alternatives:** an in-text `@[Name](user:id)` token would need a
custom mark + serializer and a notify-time regex (fragile, splits on edit); a
side-table drifts from the text on edit and still needs the editor to emit a
marker. The node is the only option that is simultaneously the storage AND the
source of truth AND reusable in every TipTap field by adding one extension.

### Reusability contract

The mention node + its Suggestion config live in **one shared editor extension**
(`frontend/src/components/shared/editor/mention-extension.ts`) consumed by the
shared `RichTextEditorImpl`. Card descriptions and notes already route through
that one editor, so both get mentions from a single wiring point. A new TipTap
field inherits mentions for free — that is the "consistent across future text
inputs" requirement, satisfied structurally.

## 2. Backend mention extraction (the resolver)

A pure, dialect-free helper walks a PM-JSON doc and returns the set of mentioned
user-ids — the ONE place text becomes a recipient set.

```
app/services/mentions/extract.py
  extract_mention_ids(content: str | dict | None) -> set[uuid.UUID]
```

- Accepts the same shapes the note content_normalizer accepts (None / "" / dict
  / JSON string) and tolerates malformed input by returning `set()` (never raises
  — a parse failure must NOT roll back the triggering mutation).
- Recursively visits `content` arrays; collects every node with
  `type == "mention"` and a parseable `attrs.id` UUID. Ignores `label`.
- Deterministic, no I/O, no DB — unit-testable in isolation.

**New-mention diff (notify-on-add, not on every save):** the producer computes
`new_ids = extract(after) - extract(before)`. Only genuinely-new mention ids
trigger generation. On create, `before` is empty so all mentions are new. On
edit, only ids absent from the prior content fire. This is the FUNCTIONAL guard;
the dedupe_key (below) is the IDEMPOTENCY backstop that makes a double-fire a
no-op even if the diff is bypassed.

## 3. Generation hook (feeds the existing pipeline)

Mentions reuse `NotificationService.generate_for_event` inside a `begin_nested()`
savepoint — identical failure-isolation to the activity/approval hooks (a
generation bug degrades to a no-op, never rolls back the card/note write).

A single private producer is shared by both surfaces:

```
app/services/mentions/notify.py
  async def notify_new_mentions(
      db, *, workspace_id, board_id, actor_id,
      entity_type: "card" | "note", entity_id,
      card_id: uuid | None,          # the card to deep-link to (== entity for cards;
                                     #   the note's card_id for card-scoped notes)
      before_content, after_content,
  ) -> None
```

For each id in `extract(after) - extract(before)`, call:

```python
generate_for_event(
    db,
    workspace_id=workspace_id,
    board_id=board_id,
    category="mention",
    actor_id=actor_id,                       # the mentioner; dropped by INV-3
    is_agent_actor=current_agent_id.get() is not None,
    entity_type=entity_type,                 # "card" or "note"
    entity_id=entity_id,
    dedupe_seed=str(mentioned_user_id),      # ⇒ key = mention:{entity_id}:{user_id}
    params={"mentioned_user_id": str(mentioned_user_id)},
    link=<deep-link, §5>,
)
```

The whole loop is wrapped in ONE `begin_nested()` + broad `except` + `logger.
exception` (mirrors `_generate_notifications`).

### Recipient resolution (the one generation-service change)

`mention` is already in `_CARD_PARTICIPANT_CATEGORIES` and `_ACTOR_CATEGORIES`,
but card-participants is the WRONG recipient set for a mention — the recipient is
the explicitly mentioned user. Add a dedicated branch BEFORE the card-participant
fallback in `_resolve_recipients`:

```python
if category == "mention":
    raw = params.get("mentioned_user_id")
    return {uuid.UUID(str(raw))} if raw else set()
```

and REMOVE `"mention"` from `_CARD_PARTICIPANT_CATEGORIES` (so the shared
card-load path doesn't run for it) while KEEPING it in `_ACTOR_CATEGORIES` (the
copy needs `actor_name`). `params["card"]` enrichment for the mention's deep-link
title is supplied by the producer (it already has the card), so no card eager-load
is required in generation for `mention`.

- **INV-3** holds automatically: `recipients.discard(actor_id)` ⇒ mentioning
  yourself never notifies you.
- **INV-6** holds: `dedupe_key = mention:{entity_id}:{user_id}` is stable per
  (entity, mentioned-user) ⇒ remove→re-add is a `ON CONFLICT DO NOTHING` no-op.

## 4. Producer wiring (the two surfaces)

- **Card description** — `CardService.update_card` and `create_card`: capture
  `before.description` (snapshot already taken for activity) and the new
  `description`; after the repo write, call `notify_new_mentions(entity_type=
  "card", entity_id=card_id, card_id=card_id, before, after)`.
- **Note content** — `NoteService.create_note` (before = "") AND `update_note`
  (before = the pre-update content). `update_note` currently records an activity
  but produces no notification; the mention producer is called explicitly there.
  `card_id` for the deep-link = the note's `card_id` (may be None ⇒ link to the
  note in its board/workspace scope, §5).

Both surfaces call the SAME `notify_new_mentions`. No mention logic is duplicated.

## 5. Deep-link

Reuse the notification `link` shape consumed by `link-to-route.ts`:

- Card mention → `{"kind": "card", "card_id": "<id>"}` (+ board context as the
  other card categories carry it).
- Card-scoped note mention (note has `card_id`) → link to that card (same shape)
  so the recipient lands on the card whose note mentioned them.
- Workspace/board note with no `card_id` → `{"kind": "note", "note_id": "<id>",
  "board_id": <id|null>}`. `link-to-route.ts` resolves this to the notes tab with
  `?note=<id>` (board-scoped → `/{slug}/boards/{board_id}/notes?note=<id>`,
  workspace-scoped → `/{slug}/notes?note=<id>`); `NoteList` reads `?note=` and
  opens the matching note (mirrors BoardView's `?card=`). The resolved `link`
  also travels on the `notification.created` WS push so the opt-in OS toast can
  deep-link on click.

## 6. Member search endpoint (autocomplete source)

Extend the EXISTING `GET /api/workspaces/{slug}/members` with an optional
`?q=<str>&limit=<int>` filter rather than adding a new route:

- `q` → case-insensitive `ILIKE %q%` over `user.name` OR `user.email`.
- `limit` default 10, capped (e.g. 20) — autocomplete needs a short list.
- Repository gains `search_members(workspace_id, q, limit)`; the no-`q` call path
  is unchanged (full list, existing behavior preserved). Response schema
  unchanged (`WorkspaceMemberRead[]` — already carries `user_id`, `email`,
  `name`, `role`).

## 7. Frontend

### 7a. Shared mention extension (the reusable primitive)

`frontend/src/components/shared/editor/mention-extension.ts` — configures
`@tiptap/extension-mention` (TipTap v3, same family already in package.json):

- `@` trigger → Suggestion popover anchored at the caret.
- Items fetched via a `useWorkspaceMemberSearch(slug, query)` React-Query hook
  hitting `GET /members?q=`. Debounced; workspace-scoped query key.
- Renders the picker with the existing **RoleCombobox dropdown pattern**
  (`bg-popover shadow-soft border-border/70`, `hover:bg-accent`) — no new cmdk
  dependency (none exists in the repo).
- The chosen member inserts a `mention` node `{id, label}`.
- A React **node-view** renders the inserted mention as a subtle inline chip
  using the **Pill `primary`** aesthetic (`bg-primary/14 text-primary`,
  rounded-full, NOT uppercase for inline reading), matching the notification
  surface. Display-only; no GSAP needed inline (sober). If any motion is added it
  is scale/opacity only (GSAP cannot tween color-mix — notification-system rule).

The extension is registered in the shared `RichTextEditorImpl`, so BOTH
`CardDetailSheet` (card description) and `NoteEditor` (note content) get it with
zero per-surface code.

### 7b. Render in read-only view

`RichTextRenderer` (the `editable:false` TipTap) registers the SAME extension so
mention chips render identically in display contexts. Plain-text extraction
(`extractPlainText`) must emit `@Label` for a mention node so previews/search show
the name (currently it would drop the atom).

### 7c. i18n

`notifications.category.mention.{title,body}` ALREADY exists in every registered
locale (currently `en`, `es`, and `pt-BR`) with `{{actor}}`/`{{card}}` — no
notification-copy change. Any NEW UI strings (picker empty state, etc.) go under
a `mentions.*` namespace with parity across every registered locale.

## 8. Invariants (mention-specific, atop the notification INV-1..6)

- **MEN-1 (id is identity):** recipient resolution uses ONLY `attrs.id`; `label`
  is display-only and never trusted for who-to-notify.
- **MEN-2 (notify on new only):** generation fires for `extract(after) -
  extract(before)`; an unchanged mention on a re-save never re-fires (diff =
  functional guard, dedupe_key = idempotency backstop).
- **MEN-3 (mentionable = workspace member):** a mention id that is not a current
  workspace member resolves to a recipient that `get_for_users`/membership
  naturally yields nothing actionable for; the picker only offers members, and
  generation tolerates a stale id (no row created if the user can't be a
  recipient). No mention of a non-member is creatable through the UI.
- **MEN-4 (parse never poisons the txn):** `extract_*` and the producer are
  wrapped so a malformed doc or generation error degrades to a no-op and NEVER
  rolls back the card/note write (savepoint + broad except, a hard-won production lesson).
- **MEN-5 (one producer, two surfaces):** card and note both call the single
  `notify_new_mentions`; no surface re-implements extraction or generation.

## 9. Out of scope (deferred)

- Mentions in surfaces beyond card descriptions + notes (the shared extension
  proves reusability; wiring a 3rd field is a one-liner when one appears).
- Group / `@team` / `@everyone` mentions.
- A mention side-table for "everywhere I'm mentioned" queries (pure read
  optimization; the content JSON remains the source of truth).
- Notifying on mention REMOVAL or editing an existing mention's label.

## 10. TDD plan (RED → GREEN per layer)

1. `extract_mention_ids` — pure unit tests (empty/malformed/nested/dupe/non-UUID).
2. `notify_new_mentions` — diff semantics (create-all-new, edit-only-new,
   re-add-silent), INV-3 self-mention drop, savepoint isolation on bad doc.
3. `_resolve_recipients` mention branch — explicit-id resolution, no card load.
4. Member search — `?q=` ILIKE name/email, limit cap, no-`q` unchanged.
5. Card + note integration — real PATCH/POST emits exactly the new-mention
   notifications; PG-dialect compile assertion that no IntegrityError path exists
   (production regression guard) — already covered by the repo upsert, assert reuse.
6. FE — extension inserts a node; node-view chip renders; extractPlainText emits
   `@Label`; member-search hook; parity across every locale registered by
   `frontend/src/i18n/supported-languages.ts` for new `mentions.*` keys.
