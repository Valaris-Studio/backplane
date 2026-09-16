# Changelog

All notable changes to `backplane-mcp` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-09-13

### Changed

- **Breaking:** `list_notes` returns `{notes, total, limit, offset, has_more,
  next_offset, _hint}` instead of a bare array and omits bodies by default.
  Read `notes`, follow `next_offset` with the same filters, and explicitly pass
  `summary_only=false` when raw bodies are needed. Defaults are 25 notes at
  offset zero; page sizes are 1–100. Title/body search (`q`), `pinned_only`,
  `kinds` and board-linked `card_id` compose before paging. `card_id` without
  `board_id` now fails. Pages are live, so restart if notes change. Upgrade the
  backend alongside MCP; the raw HTTP API's array shape is unchanged.

- Compatibility aliases remain callable in 0.8.0. Their planned removal moves
  from 0.8.0 to 0.9.0; use the canonical tools listed in the 0.7.0 migration table.

### Added

- Connection preset guidance pairs `get_server_info` with read-only native
  calls to check server configuration, board access and requested tools.
  A successful server check does not prove that a fixed-catalog client can
  call those tools; complete the native-tool check in the connected client.

### Fixed

- Explicit failure receipts now set the MCP protocol `isError=true` while
  preserving their content, so clients and tracking agree that the call failed.
- Loop stop/resume receipts report the backend's stored `disabled_reason`;
  repeated same-state calls no longer imply that a new reason was persisted.

- `bulk_create_cards` preserves `git_repo_slug` and other supported create
  fields. Unknown or non-board repository slugs reject the entire batch with
  422 before any cards are created; single-card fallback behavior is unchanged.
- Note and card mutation receipts identify raw ProseMirror content through
  `_content_format` / `_description_format` and `_hint`. Use
  `get_note(format="markdown")` or `get_card` for an editable read, or preserve
  the original markdown before making further edits.

- Toolset activation no longer equates notification delivery with client catalog
  refresh. Responses include an unverified client status and the exact server
  startup environment needed to preserve the selected toolsets across restarts,
  including idempotent calls. Documentation covers local stdio and remote HTTP
  recovery. Clients with fixed catalogs can select their native tools at startup;
  dynamic refresh and runner allowlist enforcement remain unchanged.

## [0.7.3] - 2026-09-05

### Fixed

- `MCP_TRANSPORT=streamable-http` starts. Since 0.1 the transport branch
  passed `host`/`port` to `FastMCP.run()`, which only accepts `transport`
  and `mount_path` on every supported SDK (1.12 through 1.29), so the server
  died with `TypeError: FastMCP.run() got an unexpected keyword argument
  'host'` before listening. `MCP_HOST` (default `0.0.0.0`) and `MCP_PORT`
  (default `8001`) are now applied through `mcp.settings` before `run()`,
  which is where the SDK's uvicorn config reads them. stdio is unchanged.
  Transport selection is covered by unit tests and a live HTTP smoke that
  completes `initialize`, `tools/list` and one tool call against the
  started server (audit 2026-09-04, T03).

## [0.7.2] - 2026-09-04

### Fixed

- The execution tracker now unwraps the tool result FastMCP hands it after
  conversion (a `list[TextContent]`, an `(unstructured, structured)` tuple,
  or a `CallToolResult`) before classifying it: the text of the content
  blocks, newline-joined, is what gets parsed for the error payload, card
  ids and the `result_summary`. Since FastMCP's `convert_result` path the
  tracker only understood `str`, so every execution row was recorded
  `completed` with an empty `cards_affected` and a `result_summary` that was
  a `TextContent` repr, and tool bodies returning the error JSON were
  recorded as successes.
- A tool call that raises (for example a hand denial `PermissionError`
  carrying the `tool_not_allowed` payload) is recorded `failed`, with the
  exception text as `error_message` and the payload as `result_summary`.
  Before, it was recorded with no result and classified `completed`.
- `install_tracking` installs once per tool manager and resolves the calling
  session's tracker per request (the same shape as `install_hand`). It used
  to install one wrapper per lifespan; under streamable-http the lifespan
  runs once per HTTP session, so N sessions stacked N tracker layers on the
  shared tool manager. stdio runs one lifespan per process and was
  unaffected.

## [0.7.1] - 2026-09-04

### Added

- `enable_toolsets(toolset_ids)` (category `server-info`, so it is in the
  default interactive hand and on every explicit hand) widens the running
  session's hand: the ids are the values `VALARIS_MCP_TOOLSETS` accepts
  (`all`, `default`, or any group/category id from
  `get_server_info.toolsets.available`). Widen-only, idempotent, per-process,
  never persisted. The runner allowlist (`VALARIS_MCP_ALLOWLIST`) stays a
  ceiling: the widened set is re-intersected with it, and under a runner
  launch that sets only the allowlist (toolset layer already `all`) the call
  is a no-op.
- After a widening that adds tools the server sends
  `notifications/tools/list_changed`; the handshake now advertises
  `tools.listChanged: true` (false before 0.7.1). `VALARIS_MCP_TOOLSETS`
  still picks the initial hand and is the fallback for clients that ignore
  list-changed notifications.
- `get_server_info` reports the widened state (`toolsets.loaded`,
  `enabled_tools`, `listing_bytes`) and its `toolsets.hint` names
  `enable_toolsets`.

### Upgrade note

Nothing to change: interactive sessions can now widen the hand without a
restart; runner grants are unaffected.

## [0.7.0] - 2026-09-04

MCP #4 — consolidate near-duplicate tools. Every retired or renamed tool
stays registered as a **deprecated alias** until 0.8.0: it answers as before,
logs one warning per call, stamps its result with `_deprecated`, is listed on
the wire with `_meta.deprecated` (`replacement`, `removed_in`) and a
`DEPRECATED` description, and belongs to no toolset — so only `all` (or a
runner allowlist that still names it) lists it. `get_server_info` reports
the live surface under `tools`/`tool_count`, the aliases under
`deprecated_aliases` (+ `deprecated_removed_in`), and the granted ones under
`allowlist_deprecated`; the runner's loop pre-flight and `backplane-runner
-doctor` warn when a stored grant names one.

### Upgrade note — retired tools and their replacements

| retired (alias until 0.8.0) | use instead |
|---|---|
| `claim_card` | `next_assignment` (runners); `move_card` into the `active`-typed column + `add_card_participant(role="hero")` (interactive) |
| `append_note` | `update_note(mode="append", content=…)` |
| `replace_note_section` | `update_note(mode="section", anchor_heading=…, content=…)` |
| `get_workspace_velocity` | `get_workspace_metrics(view="velocity")` (same `velocity` + `quality` keys) |
| `get_workspace_cost` | `get_workspace_metrics(view="cost")` (the old body under a `cost` key) |
| `hard_delete_agent` | `update_agent(agent_id, hard_delete=true)` (the flag is the confirmation; no other field) |
| `delete_webhook` | `update_webhook(workspace_slug, webhook_id, delete=true)` (no other field) |
| `get_board_loop_binding` | `get_board_loop_binding_raw` (same params and body; the raw view behind `get_board_loop`) |
| `list_skill_bindings` | `list_skill_bindings_raw` (same params and body; the raw rows behind `list_skills(board_id)`) |
| `get_loop_template_profile` | `get_loop_template(ref, view="profile")` |
| `preview_loop_template` | `get_loop_template(ref, view="preview", slot_values=…, board_id=…, include_prompts=…)` |
| `check_loop_template_fit` | `get_loop_template(ref, view="fit", board_id=…)` |
| `lint_loop_template` | `get_loop_template(ref, view="lint")` |
| `remove_card_participants_by_role` | `remove_card_participant(card_id, pipeline_role=…)` (instead of `user_id`) |

### Changed

- `update_note` gains `mode` (`replace` default, `append`, `section`) and
  `anchor_heading`; title/pinned/card_id apply in every mode, before the body
  operation. Its `idempotentHint` is now false (append is additive).

- `get_workspace_metrics(view="all"|"velocity"|"cost")` is the one
  workspace-wide delivery + spend read (velocity, quality, cost). It replaces
  the velocity/cost pair in the interactive default hand.

- `update_agent(hard_delete=true)` and `update_webhook(delete=true)` carry
  the permanent deletes; both tools now advertise `destructiveHint: true`.

- The raw views carry an explicit suffix: `get_board_loop_binding_raw`
  (vs `get_board_loop`, the effective config) and `list_skill_bindings_raw`
  (vs `list_skills(board_id)`, the effective set); each description opens by
  saying so.

- `get_loop_template(view="full"|"profile"|"preview"|"fit"|"lint")` is the
  one loop-template read; the folded aliases' `template_ref` is `ref` here.

- `remove_card_participant` takes exactly one selector: `user_id` (one
  person) or `pipeline_role` (every holder of a stage role); it now
  advertises `idempotentHint: true`. The default pipeline's rework step and
  the runner's `mcp_call` dispatch use the folded form (the old name still
  dispatches).

### Removed from the live surface

- `claim_card`: the legacy human/admin claim path. Runners pick up work via
  `next_assignment`; interactive sessions claim by `move_card` +
  `add_card_participant`. No shipped template granted it.
- `append_note`, `replace_note_section`: folded into `update_note(mode=…)`.
  The documentator and secretary system templates now grant `update_note`
  (documentator v3, secretary v2).
- `get_workspace_velocity`, `get_workspace_cost`: folded into
  `get_workspace_metrics`. The secretary system template (v3) grants it.
- `hard_delete_agent`, `delete_webhook`: folded into the flags above.
- `get_board_loop_binding`, `list_skill_bindings`: renamed with the `_raw`
  suffix.
- `get_loop_template_profile`, `preview_loop_template`,
  `check_loop_template_fit`, `lint_loop_template`: folded into
  `get_loop_template(view=…)`.
- `remove_card_participants_by_role`: folded into
  `remove_card_participant(pipeline_role=…)`.

## [0.6.0] - 2026-09-03

The MCP #1 items (tool annotations and titles, per-parameter descriptions,
the wire budget, the `server-surface.json` fixture) landed on 2026-09-02;
toolsets and the release itself on 2026-09-03.

### Breaking

- An unchanged config now loads the interactive default hand instead of the
  full tool surface. With `VALARIS_MCP_TOOLSETS` unset the server lists the
  start here, work management and knowledge & content groups minus
  workspace-admin, destructive and claim verbs, plus a few read-only helpers.
  To keep the full surface, add one line to the server env:
  `"VALARIS_MCP_TOOLSETS": "all"`. Runner launches are unaffected: a present
  `VALARIS_MCP_ALLOWLIST` with no toolsets env loads every toolset (the
  allowlist is the hand), and new runner binaries pin `all` explicitly.

### Added

- `VALARIS_MCP_TOOLSETS`: toolsets select which slice of the tool surface a
  session lists. Unset loads the interactive default hand (see Breaking);
  `all` loads every tool; a comma list of group/category ids (with `default`
  as an alias, repeats collapsed) composes a custom hand. Every explicit hand
  also carries the `server-info` category (`get_server_info`, `whoami`), so
  discovery and identity are always listable. An unknown id exits with status 2 and one stderr line before the
  transport starts. Toolsets compose with `VALARIS_MCP_ALLOWLIST` by
  intersection, so a runner stage grant is never narrowed twice.
- `get_server_info.toolsets`: what is loaded, `resolved_tool_count` (the
  toolset hand before the allowlist intersection), the default ids, every
  available toolset with its tool count, and a hint on how to widen the
  hand. `enabled_tools` and `listing_bytes` describe the composed hand;
  allowlist entries clipped by the loaded toolsets are reported under
  `allowlist_outside_toolsets`. A denied call under a toolset filter names
  the active toolsets in its `tool_not_allowed` payload.
- Listing filter: the allowlist now filters `tools/list` as well as gating
  `tools/call`, so a session is only told about the tools it can call.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
  and titles on every tool, from one catalog table (`catalog.TOOL_META`).
- Per-parameter descriptions: each tool's `Args:` block is moved into its
  input schema, and structured output is switched off.
- A wire budget for `tools/list` (listing bytes and per-description cap)
  guarded by tests, plus the `server-surface.json` fixture exported for the
  in-app MCP reference (`scripts/export-tool-catalog.py`).

## [0.5.0] - 2026-08-27

- Release with the `relax_done_merge_gate` parameter on `set_board_loop` (the
  done-gate auto-relax on human self-merge saves); 0.4.0 was never published,
  so its changes ship here.
