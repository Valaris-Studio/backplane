# Backplane — Notification System Contract (v1)

> Frozen design contract. Phases 1–6 build against this. White-label, TDD, layered.
> Authored 2026-06-14 after 2-agent infra research + ground-truth verification against
> `activity.py`, `approvals/approval.py`, `models/kanban/card.py`, `models/agents/agent.py`.

## Confirmed scope decisions (user, 2026-06-14)

1. **Feed scope** = per-workspace badge + "All workspaces" rollup tab. Every notification
   carries `workspace_id`; the bell badge counts the *current* workspace's unread; the inbox
   defaults to current workspace with an all-workspaces tab.
2. **Default noise floor** = relevant-to-me. New users get notified only for things they're
   involved in (participant on the card, approval waiting on them, run on a board they follow);
   generic workspace churn is OFF by default and opt-in.
3. **@mentions** = deferred to a fast-follow card. v1 generates purely from existing platform
   events. The category taxonomy reserves a `mention` category so adding it later is data-only.
4. **No new transport now** (email/telegram) — but the `NotificationChannel` abstraction ships
   in v1 so they drop in later as plugins with zero change to generation.

## Core architectural invariants

- **INV-1 (durable in-txn):** A notification row is written **synchronously inside the same DB
  transaction** as the triggering activity/approval write. The notification can never exist
  without its event, nor be lost on restart, nor miss an offline user. The `event_bus` is
  **only** the live-push transport to already-connected WS clients — never the source of truth.
  (Rationale: `event_bus` is in-process, fire-and-forget `asyncio.gather(return_exceptions=True)`,
  single Cloud Run instance — `backend/app/core/event_bus.py`.)
- **INV-2 (two source paths):** Generation hooks into BOTH:
  - `ActivityService.record()` — after `self.repo.record(...)` (`activity.py:67`), before bus publish.
  - `ApprovalService.create_approval` / `.decide` — after the repo write, before bus publish
    (`approvals/approval.py:45` and `:101`). Approvals bypass ActivityService entirely.
- **INV-3 (never notify the actor):** Suppress the row whose `recipient_user_id == actor_id`.
- **INV-4 (agent-actor awareness):** A runner has NO backing User; `actor_id` of runner-driven
  activity = the human `created_by_id`, with `current_agent_id` set. Runner churn must NOT flood
  that human. Generation records `is_agent_actor` on the notification and the default prefs treat
  high-volume runner churn categories as OFF — see category table.
- **INV-5 (white-label):** No human-readable category copy in backend logic. The backend emits a
  stable `category` key + structured params; ALL display strings live in FE i18n with parity across every registered locale (currently `en`, `es`, and `pt-BR`).
- **INV-6 (idempotent):** Re-running generation for the same (event, recipient) must not create a
  duplicate. Keyed on a deterministic `dedupe_key` (see model).
- **INV-7 (no dead ends):** Every notification carries a link that RESOLVES to a route. Storing a
  `link` is not enough — it must hold the fields `linkToRoute` requires (`board_id` for kind
  `card`/`board`, `note_id` for `note`, and a `workspace_slug` for every kind), or the FE hides the
  CTA and the row is a dead end ("Jordan changed a card you're following." — *which card?*).
  Producers know only their own local ids, so `generate_for_event._resolvable_link` enriches at the
  single choke point: it fills only ABSENT keys (a producer that named a target wins; an explicit
  `None` is a statement of scope, as for a workspace-scoped note), and turns a `None` link into a
  `{kind: "workspace"}` link — for events like `workspace_member` with no per-entity destination,
  the workspace beats a dead end. Existing rows written before INV-7 keep their partial links and
  render as they did; no backfill.

## Category taxonomy (stable keys — the white-label contract)

These are the *semantic* categories the FE preferences grid and i18n key off. Each maps from one
or more raw (entity_type, action) activity pairs or approval events. Categories — NOT raw actions —
are what users toggle (raw actions are too granular to be usable).

| category key | source event(s) | relevant-to-me default | workspace-wide default | notes |
|---|---|---|---|---|
| `mention` | (reserved; @mention fast-follow) | ON | ON | no producer in v1 |
| `card_assigned` | card participant added where recipient == added user (hero/helper) | ON | ON | "you were added to a card" |
| `card_participant_changed` | card moved / updated / status where recipient is a participant (≠ actor) | ON | OFF | the core "card I follow changed" |
| `card_comment` | note created with card_id where recipient is a participant | ON | OFF | (note = comment surface) |
| `dependency_blocking` | dependency_added/replaced where a card the recipient participates in gains a blocker | ON | OFF | "something now blocks your card" |
| `approval_requested` | approval.created, status=pending | ON | ON (admins) | waiting-on-a-human |
| `approval_decided` | approval.updated (approved/rejected) where recipient is the requesting runner's creator | ON | OFF | "your approval was decided" |
| `board_run_finished` | (run lifecycle — see open item R) | ON (followers) | OFF | "the runner finished your board" |
| `card_created` | card created | OFF | OFF | high volume; opt-in only |
| `workspace_member` | added_member/removed_member where recipient is the affected user | ON | OFF | "you were added/removed" |
| `resource_note_shared` | note/resource created at workspace scope (board_id NULL) | OFF | OFF | opt-in |

"relevant-to-me default" = the value in a new user's prefs for that category when their relevance
filter is `watching` (the default). "workspace-wide default" = the value when they switch the
relevance filter to `everything`.

## Relevance filter (the primary anti-flood lever)

Per-user, per-workspace setting `relevance_scope ∈ {watching, everything}`, default `watching`.
- `watching` = only generate a notification for a recipient if they are **involved**: a participant
  on the subject card, the affected member, the approval's owning human, or a follower of the board.
- `everything` = generate for all workspace members for any category whose `everything` default
  (or per-user override) is ON.

A category can be force-disabled regardless of relevance scope via the per-user grid.

## Data model

### Table `notifications`
| column | type | notes |
|---|---|---|
| `id` | UUID PK | UUIDMixin |
| `recipient_user_id` | UUID FK users, ON DELETE CASCADE, indexed | who sees it |
| `workspace_id` | UUID FK workspaces, ON DELETE CASCADE, indexed | scope for badge/tab |
| `board_id` | UUID FK boards, ON DELETE SET NULL, nullable | deep-link context |
| `category` | String(48), indexed | stable taxonomy key (INV-5) |
| `actor_id` | UUID FK users, nullable | who caused it (display "X did Y") |
| `is_agent_actor` | bool, server_default false | INV-4 |
| `entity_type` | String(32) | deep-link target type |
| `entity_id` | UUID, nullable | deep-link target id |
| `title_key` / `body_key` | (NOT stored) | FE derives copy from category + params |
| `params` | JSON | structured interpolation values (card title, column names, actor name, count, etc.) — pre-resolved at generation so the FE never re-queries |
| `link` | JSON, **never null in practice** | `{kind, workspace_slug, board_id?, card_id?, approval_id?, resource_id?}` — FE resolves to a route. See INV-7. |
| `read_at` | DateTime, nullable, indexed-with-recipient | seen state; NULL = unread |
| `dedupe_key` | String(255), unique-with-recipient | INV-6: `f"{category}:{entity_id}:{source_seq_or_approval_id}"` |
| `created_at` | DateTime server_default now() | UUIDMixin/TimestampMixin |

Indexes: `ix_notifications_recipient_created (recipient_user_id, created_at DESC)`,
`ix_notifications_recipient_workspace_unread (recipient_user_id, workspace_id, read_at)`,
unique `uq_notifications_recipient_dedupe (recipient_user_id, dedupe_key)`.

> Migration safety: all new table → always safe to add. Booleans get server_default. No backfill.

### Table `notification_preferences`
One row per (user, workspace). Workspace-scoped so a user can be loud in one workspace, quiet in another.
| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK users, ON DELETE CASCADE | |
| `workspace_id` | UUID FK workspaces, ON DELETE CASCADE | |
| `relevance_scope` | String(16), default `watching` | watching \| everything |
| `category_overrides` | JSON, default `{}` | `{category_key: {in_app: bool, email?: bool, ...}}` sparse — absent = use category default for current relevance_scope |
| `muted` | bool, default false | global kill-switch for this workspace |
| `created_at`/`updated_at` | | |

Unique `uq_notif_prefs_user_workspace (user_id, workspace_id)`. A missing row = all defaults
(lazy-created on first PUT). The resolver computes effective on/off per (category, channel) from:
`muted` → `category_overrides[cat][channel]` → category default keyed by `relevance_scope`.

## Channel / transport abstraction

```
class NotificationChannel(ABC):
    key: str                                  # "in_app", later "email", "telegram"
    async def deliver(self, notification, recipient, db) -> None: ...
    def is_enabled_for(self, effective_prefs) -> bool: ...     # reads category_overrides[cat][self.key]

class InAppChannel(NotificationChannel):
    key = "in_app"
    # deliver() = (a) the durable row is ALREADY written by the generator (INV-1);
    #             (b) fire event_bus.publish("notification.created", targeted payload).
```

A module-level `CHANNEL_REGISTRY: dict[str, NotificationChannel]` holds enabled channels. v1 =
`{"in_app": InAppChannel()}`. EmailChannel/TelegramChannel later: implement + register; the
generator iterates `CHANNEL_REGISTRY.values()` and calls `is_enabled_for` then `deliver`. The
preferences grid auto-renders a column per registered channel key (FE reads channel keys from a
`GET /notifications/channels` capability endpoint so adding a channel is data-driven on the FE too).

## Generation flow (NotificationService.generate_for_event)

```
generate_for_event(db, *, workspace_id, board_id, category, actor_id, is_agent_actor,
                   entity_type, entity_id, dedupe_seed, params, link):
  recipients = resolve_recipients(category, workspace_id, board_id, entity_id)  # per relevance
  recipients -= {actor_id}                                                       # INV-3
  for user in recipients:
    eff = resolve_prefs(user, workspace_id)
    if eff.muted: continue
    for channel in CHANNEL_REGISTRY.values():
      if not channel.is_enabled_for(eff, category): continue
      row = upsert_notification(dedupe_key=...)   # INV-6, in-txn (INV-1)
      await channel.deliver(row, user, db)
```

`resolve_recipients` is the relevance brain: for `card_*` categories → the card's participant
user_ids (loaded via selectinload); for `approval_*` → the runner's `created_by_id` (+ workspace
admins for `approval_requested`); for `workspace_member` → the affected user; for `board_run_finished`
→ board followers (open item R). All call-sites pass the minimal seed and let the service resolve.

## API surface (all under `/api`, current-user scoped — NOT workspace-admin)

| method + path | purpose | auth |
|---|---|---|
| `GET /notifications` | keyset list: `?workspace={slug}` (omit = all workspaces), `limit≤100`, `before=<datetime>`, `unread=true?` | current user only |
| `GET /notifications/unread-count` | `?workspace={slug}` (omit = total) → `{count}` | current user only |
| `POST /notifications/{id}/read` | mark one read (idempotent) | owner only (404 if not recipient) |
| `POST /notifications/read-all` | `?workspace={slug}` → mark all read | current user only |
| `GET /notifications/channels` | capability list of registered channel keys | any auth |
| `GET /notifications/preferences?workspace={slug}` | effective + raw prefs | current user only |
| `PUT /notifications/preferences?workspace={slug}` | upsert prefs (relevance_scope, category_overrides, muted) | current user only |

Response = flat list of `NotificationRead` (no envelope), DESC by created_at, keyset by `before`.
These are NOT under `/api/workspaces/{slug}/...` because they're cross-workspace user-owned; the
optional `?workspace=` filter narrows. Authorization: the recipient is always the current user;
no row leaks across users. Workspace membership is re-verified when `?workspace=` is supplied.

## WS event shape (live push, INV-1 transport-only)

`event_type = "notification.created"`, published with the recipient's `workspace_id`. Payload:
```
{ "notification_id": str, "recipient_user_id": str, "category": str,
  "workspace_id": str, "unread_delta": 1 }
```
The connection_manager delivers only to sockets whose `user_id == recipient_user_id` (new targeted
delivery — today delivery is workspace-pattern based; add a per-user filter). FE `useDomainSync`
subscribes `"notification.*"`, increments the badge optimistically on a matching recipient, and
debounce-invalidates the inbox query. `notification.read` may also be emitted for multi-tab sync
(fast-follow; not required for v1).

## Frontend contract

- Feature module `frontend/src/features/notifications/{api,components,hooks,utils}`.
- `notificationKeys`: `inbox(slug?)`, `unreadCount(slug?)`, `preferences(slug)`, `channels()`.
- Bell mounts in `TopBar.tsx` right-controls div (before `ConnectionStatusIndicator`).
- Inbox = `Sheet` (right drawer); items use `ScrollArea`; per-item read-on-click + deep-link CTA.
- Prefs = `Dialog` with category × channel grid (`toggle.tsx` switches) + relevance `select`.
- GSAP badge (reuse idiom from `count-up.tsx`/`sheet.tsx`/`FirstRunPanel.tsx`): spring count-in
  (`back.out`), pulse-ring on arrival (opacity/scale only — INV: can't tween color-mix),
  drain animation on read-all. `useReducedMotion()` gates all motion; `tween.kill()` + `clearProps`.
- Ephemeral arrival → Sonner toast (reuse `ThemedToaster`); durable list → inbox. No duplication.
- i18n: `notifications.*` namespace, category copy as `notifications.category.{key}.{title,body}`
  with interpolation from `params`; parity across every locale registered by
  `frontend/src/i18n/supported-languages.ts` is enforced.

## Open items — RESOLVED during Phase-2 research (2026-06-14)

- **R (board_run_finished): DEFERRED to fast-follow.** Confirmed via execution-model research:
  the runner polls `next_assignment` continuously and Executions are per-card/per-session
  (`execution.completed` payload = execution_id/status/cost/tokens/summary — NO board-level "all
  cards done" aggregate; `Execution.board_id` exists but nothing emits a per-board "run finished").
  A clean signal needs a scheduled idle-detector ("no in-flight executions + no unstarted cards in
  active columns for N seconds → emit once per board, deduped across restarts"). v1 ships the other
  9 categories; `board_run_finished` is a tracked fast-follow card.
- **`is_agent_actor` source CONFIRMED:** `Activity.agent_id IS NOT NULL` on the freshly-written row
  (the repo stores `current_agent_id.get()`). No contextvar access needed inside generation.
- **`card_comment` note→card linkage:** `NoteService.create_note` does NOT pass the note's
  `card_id` into the activity `record()`. **Resolution: enrich the note activity's `changes` with
  `{"card_id": str(card_id)}` when the note is card-scoped** (one-line, backward-compatible) so
  generation stays a pure consumer of the activity payload and never re-fetches the Note.
- **actor_id CONFIRMED always a User PK** (never a runner id) across all call sites — suppressing
  `recipient == actor_id` and resolving actor display name is safe.
- **MissingGreenlet guard:** generation runs DEEP inside the triggering service's txn. It MUST load
  context with explicit `selectinload` via repos (CardRepository.get_by_id eager-loads
  participants→user/agent; WorkspaceMemberRepository.list_members eager-loads user) and MUST NOT
  call other services or touch lazy="raise" relationships. Mirror `build_board_baseline`'s pattern.
- **Board "followers":** v1 = participants of any card on the board ∪ board creator (only relevant
  once `board_run_finished` lands). A dedicated follow model is a later enhancement.
- **Targeted WS delivery (Phase 3):** connection_manager currently filters by workspace pattern;
  add a per-user `deliver_to_user(user_id, ...)` path. Verify no regression to broadcast events.
