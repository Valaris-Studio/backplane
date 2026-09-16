// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: workspaces, boards, columns.
export const WORKSPACES_BOARDS_TOOL_DOCS: ToolDoc[] = [
  // ── Workspaces ────────────────────────────────────────────────────────────
  {
    name: "list_workspaces",
    category: "workspaces",
    kind: "read",
    description:
      "List every workspace you can access. Use it first in a session to discover the workspace_slug that all other workspace-scoped tools require.",
    params: [],
    examplePrompt:
      "Using the Backplane MCP, list my workspaces and tell me the slug of each one so I know which to work in.",
    related: ["get_workspace", "get_workspace_summary", "create_workspace"],
  },
  {
    name: "get_workspace",
    category: "workspaces",
    kind: "read",
    description:
      "Fetch one workspace's metadata — name, slug, owner, timestamps. Use when you already know the slug and need details, not the roster or counts.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
    ],
    gotchas: [
      "Does NOT return the member roster — use list_workspace_members for people.",
      "Entity counts come back null here — only list_workspaces and get_workspace_summary compute them.",
    ],
    examplePrompt:
      "Using the Backplane MCP, get the <workspace> workspace and tell me who owns it and when it was created.",
    related: ["list_workspaces", "list_workspace_members", "get_workspace_summary"],
  },
  {
    name: "list_workspace_members",
    category: "workspaces",
    kind: "read",
    description:
      "List a workspace's members with user_id, email, name, and role. Use it to resolve a person to their user_id before participant or removal calls.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "query",
        required: false,
        description: "Case-insensitive search over member names and emails.",
      },
      {
        name: "limit",
        required: false,
        description:
          "Cap on matches when query is set (default 10, max 20). Ignored without query.",
      },
    ],
    gotchas: [
      "Passing query switches to a capped autocomplete-style match, not the full roster.",
      "Card participant tools and remove_workspace_member need the user_id returned here — get_workspace does not include members.",
    ],
    examplePrompt:
      "Using the Backplane MCP, find <name or email> in the <workspace> workspace with list_workspace_members and give me their user_id and role.",
    related: ["add_workspace_member", "remove_workspace_member", "add_card_participant", "whoami"],
  },
  {
    name: "get_workspace_summary",
    category: "workspaces",
    kind: "composite",
    description:
      "Get a one-call workspace overview: entity counts, recent activity, per-board stats, and a 30-day activity trend. Use before opening a board.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
    ],
    examplePrompt:
      "Using the Backplane MCP, get a summary of the <workspace> workspace and highlight anything that changed recently.",
    related: ["get_project_context", "list_boards", "list_activity"],
  },
  {
    name: "create_workspace",
    category: "workspaces",
    kind: "write",
    description:
      "Create a new workspace with you as owner. Use only when starting a new top-level tenancy — individual projects are boards inside an existing workspace.",
    params: [
      {
        name: "name",
        required: true,
        description: "Display name for the workspace.",
      },
      {
        name: "slug",
        required: false,
        description: "URL-friendly identifier; derived from name when omitted.",
      },
    ],
    gotchas: [
      "Not idempotent: if the slug is already taken you get an error payload embedding the existing workspace, not a success.",
    ],
    examplePrompt:
      "Using the Backplane MCP, create a workspace named <Name>, then add <email> as an admin.",
    related: ["create_board", "add_workspace_member", "list_workspaces"],
  },
  {
    name: "add_workspace_member",
    category: "workspaces",
    kind: "write",
    description:
      "Add a user to a workspace by email, with a role. Unknown emails are auto-provisioned as new accounts — there is no invite or registration step.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "user_email",
        required: true,
        description: "Email address of the user to add.",
      },
      {
        name: "role",
        required: false,
        description: "One of owner, admin, member, viewer. Defaults to member.",
      },
    ],
    gotchas: [
      "A typo'd email silently creates a brand-new auto-provisioned account instead of failing.",
      "Re-adding an existing member is a silent no-op: the role you pass is IGNORED and the old role kept — this tool cannot change a member's role.",
      "Caller must be a workspace admin or owner; granting the owner role is owner-only.",
    ],
    examplePrompt:
      "Using the Backplane MCP, add <email> to the <workspace> workspace as a member.",
    related: ["list_workspace_members", "remove_workspace_member", "update_workspace_member", "add_team_member"],
  },
  {
    name: "remove_workspace_member",
    category: "workspaces",
    kind: "write",
    description:
      "Remove a member from a workspace by their user_id. Resolve the id from a name or email with list_workspace_members first.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "user_id",
        required: true,
        description: "UUID of the user to remove (not their email).",
      },
    ],
    gotchas: [
      "Takes a user_id UUID, not an email — look it up with list_workspace_members.",
      "Caller must be a workspace admin or owner. Removing an owner is owner-only, and the last owner can never be removed.",
    ],
    examplePrompt:
      "Using the Backplane MCP, look up <person> in the <workspace> workspace and remove them from it.",
    related: ["list_workspace_members", "add_workspace_member", "update_workspace_member"],
  },
  {
    name: "update_workspace_member",
    category: "workspaces",
    kind: "write",
    description:
      "Change an existing workspace member's role by their user_id. Resolve the id from a name or email with list_workspace_members first.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "user_id",
        required: true,
        description: "The UUID of the member whose role to change.",
      },
      {
        name: "role",
        required: true,
        description: "New role — one of owner, admin, member, viewer.",
      },
    ],
    gotchas: [
      "Role changes touching the owner role — granting it or demoting an owner — require an acting owner and are human-only: runner keys receive a 403 human_required.",
      "Calling with the role the member already holds is an idempotent no-op — no activity is recorded.",
    ],
    examplePrompt:
      "Using the Backplane MCP, look up <person> in the <workspace> workspace and change their role to admin.",
    related: ["add_workspace_member", "remove_workspace_member", "list_workspace_members"],
  },
  {
    name: "delete_workspace",
    category: "workspaces",
    kind: "write",
    description:
      "Permanently delete a workspace and everything inside it. The widest-blast-radius tool on the server — confirm the slug with list_workspaces first.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace to delete.",
      },
    ],
    danger:
      "Irreversible cascade: deletes every board in the workspace (with their columns, cards, definitions, and git-repo bindings) plus the workspace's notes, resources, channels, and memberships. No undo, no archive, no export step.",
    gotchas: [
      "Requires workspace admin or owner rights — the backend gate is the authorization boundary.",
      "Idempotent: deleting an already-deleted workspace reports that calmly instead of erroring, so a retrying agent converges.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list my workspaces, confirm with me which one is <workspace>, and only then delete it with delete_workspace.",
    related: ["list_workspaces", "get_workspace", "delete_board"],
  },

  // ── Boards ────────────────────────────────────────────────────────────────
  {
    name: "list_boards",
    category: "boards",
    kind: "read",
    description:
      "List all boards in a workspace with their metadata. Use it to find a board's id or slug before making board-scoped calls.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
    ],
    examplePrompt:
      "Using the Backplane MCP, list the boards in the <workspace> workspace and tell me which look active.",
    related: ["get_board", "create_board", "get_workspace_summary"],
  },
  {
    name: "get_board",
    category: "boards",
    kind: "read",
    description:
      "Fetch a board in one call: metadata plus every column with its cards. The primary way to read board state; shrink the payload via summary_only or titles_only.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "summary_only",
        required: false,
        description:
          "Return per-column counts and priority/status breakdowns with no cards. Most compact.",
      },
      {
        name: "titles_only",
        required: false,
        description:
          "Keep the cards but slim each to id/column_id/title/status/priority/card_type/labels for large boards.",
      },
    ],
    gotchas: [
      "Large boards can overflow the response cap — fall back to titles_only, then summary_only.",
      "summary_only wins over titles_only when both are set.",
    ],
    examplePrompt:
      "Using the Backplane MCP, get the <board> board in <workspace> with summary_only and describe how work is distributed across columns.",
    related: ["list_boards", "get_project_context", "search_cards", "get_board_health"],
  },
  {
    name: "create_board",
    category: "boards",
    kind: "write",
    description:
      "Create a board in a workspace, optionally seeding its structured definition (scope, objectives, milestones, and more) in the same call.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "name",
        required: true,
        description: "Display name for the board.",
      },
      {
        name: "slug",
        required: false,
        description:
          "URL slug for the board and the idempotency key — reuse it to make retries return the existing board.",
      },
      {
        name: "description",
        required: false,
        description: "Description of the board's purpose.",
      },
      {
        name: "tags",
        required: false,
        description: "List of tags for categorization.",
      },
      {
        name: "skip_default_columns",
        required: false,
        description: "Skip creating the default To Do / In Progress / Done columns.",
      },
      {
        name: "scope",
        required: false,
        description: "High-level scope/summary for the board's definition.",
      },
      {
        name: "objectives",
        required: false,
        description: 'Goals, as [{"text", "priority"?}].',
      },
      {
        name: "exclusions",
        required: false,
        description: "Out-of-scope items, as a list of strings.",
      },
      {
        name: "milestones",
        required: false,
        description: 'Milestones, as [{"title", "date", "type"?}].',
      },
      {
        name: "tech_stack",
        required: false,
        description: "Technologies, as a list of strings.",
      },
      {
        name: "stakeholders",
        required: false,
        description: 'Stakeholders, as [{"name", "role"?, "member_id"?, "channel_id"?}].',
      },
      {
        name: "constraints",
        required: false,
        description: "Hard constraints, as a list of strings.",
      },
      {
        name: "decisions",
        required: false,
        description: 'Locked decisions, as [{"decision", "rationale"?}].',
      },
      {
        name: "references",
        required: false,
        description: 'Reference links, as [{"url", "label"?}].',
      },
      {
        name: "custom_fields",
        required: false,
        description: 'Extra key/value fields, as [{"key", "value"?}].',
      },
      {
        name: "coding_standards",
        required: false,
        description: "Free-text coding standards for the definition.",
      },
      {
        name: "definition_content",
        required: false,
        description: "Raw content dict for forward-compat/unknown definition keys.",
      },
    ],
    gotchas: [
      "Idempotent ONLY with slug: same slug returns the existing board. Slugless calls always mint a NEW board (auto-slug, '-2' suffix on collision).",
      "Re-running with slug plus definition fields overwrites the existing board's definition — the definition upsert re-applies either way.",
      "The default To Do/In Progress/Blocked/Done columns are typed (backlog/active/blocked/done), so runner pickup works on a fresh board out of the box.",
    ],
    examplePrompt:
      "Using the Backplane MCP, create a board named <Board Name> with slug <board-slug> in the <workspace> workspace, seed its definition with our objectives and tech stack, and skip the default columns.",
    related: ["create_column", "update_definition", "list_boards", "delete_board"],
  },
  {
    name: "update_board",
    category: "boards",
    kind: "write",
    description:
      "Change a board's name, description, or tags. Only fields you pass are changed; the definition is edited separately with update_definition.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "name",
        required: false,
        description: "New display name.",
      },
      {
        name: "description",
        required: false,
        description: "New description.",
      },
      {
        name: "tags",
        required: false,
        description: "New tag list — replaces the existing list entirely.",
      },
      {
        name: "done_merge_gate",
        required: false,
        description:
          "Per-board done merge gate: 'inherit' clears the override and uses the workspace enforce_done_merge_gate setting; 'enforced' enables it; 'off' disables it. The gate applies to runner moves into done, not human moves.",
      },
    ],
    gotchas: [
      "Human keys only — the backend 403s runner callers on every board update, so a runner cannot rewrite board metadata or loosen the done-merge gate that judges its own moves.",
      "tags replaces the whole list — send the full set you want to keep.",
      "Changing done_merge_gate requires workspace admin or owner. A board with no linked git repo remains exempt because it cannot produce a mergeable PR.",
    ],
    examplePrompt:
      "Using the Backplane MCP, rename the <board> board in <workspace> to <New Name> and set its tags to <tags>.",
    related: ["get_board", "update_definition", "delete_board"],
  },
  {
    name: "freeze_board",
    category: "boards",
    kind: "write",
    description:
      "Freeze a board: still readable by every member, but every mutation and runner pickup is rejected with board_frozen until the workspace owner unfreezes it.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
    ],
    gotchas: [
      "Requires workspace admin or owner. Idempotent — freezing a frozen board is a no-op.",
      "Mutations on a frozen board fail with 409 and error_code board_frozen — stop retrying and surface the state instead.",
      "Runners stop picking up the board's cards immediately; in-flight executions may still report telemetry.",
    ],
    examplePrompt:
      "Using the Backplane MCP, freeze the <board> board in <workspace> so no more changes land while we review it.",
    related: ["unfreeze_board", "get_board", "update_board"],
  },
  {
    name: "unfreeze_board",
    category: "boards",
    kind: "write",
    description:
      "Unfreeze a frozen board, restoring all mutations and runner pickup. Workspace OWNER only — admins can freeze but not unfreeze.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
    ],
    gotchas: [
      "Owner-only by design: runners and admins get 403 — ask the workspace owner instead of retrying.",
      "Idempotent — unfreezing an unfrozen board is a no-op.",
    ],
    examplePrompt:
      "Using the Backplane MCP, unfreeze the <board> board in <workspace> so work can resume.",
    related: ["freeze_board", "get_board"],
  },
  {
    name: "get_board_loop",
    category: "boards",
    kind: "read",
    description:
      "Read a board's loop-mode config: enabled flag, prompts, provider/model, tool allowlist, safety caps, and disabled_reason (why the loop last stopped).",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
    ],
    gotchas: [
      "Returns a 404 error payload until loop mode is first configured (board settings → Loop Mode, or PUT /loop).",
      "The runner re-fetches this config at the top of every iteration — edits apply on the next cycle without a restart.",
      "This is the effective config. The raw authoring state behind it — template, version, slot values, drift — is get_board_loop_binding_raw.",
    ],
    examplePrompt:
      "Using the Backplane MCP, check whether loop mode is enabled on the <board> board in <workspace> and why it last stopped.",
    related: ["set_board_loop", "get_board_loop_binding_raw", "get_board"],
  },
  {
    name: "set_board_loop",
    category: "boards",
    kind: "write",
    description:
      "Edit a board's loop config and/or flip loop mode on or off. Loop agents call this with enabled=false and a concise reason when done or blocked.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "enabled",
        required: false,
        description:
          "True to start/resume the loop, false to stop it. Omit to edit config without touching the state.",
      },
      {
        name: "reason",
        required: false,
        description:
          "Why the loop is being turned off — stored as disabled_reason and shown on the board. Ignored when enabling.",
      },
      {
        name: "loop_prompt",
        required: false,
        description: "The per-iteration user prompt — the loop's brain.",
      },
      {
        name: "system_prompt",
        required: false,
        description: "The session system prompt.",
      },
      {
        name: "provider",
        required: false,
        description: 'Coding-agent suggestion (free string; "" = runner default).',
      },
      {
        name: "model",
        required: false,
        description: "Tier alias (premium/mid/low) or a concrete model id.",
      },
      {
        name: "tools",
        required: false,
        description:
          "MCP tool allowlist (mcp__valaris__* names; empty list = full platform surface). Replaces the stored list.",
      },
      {
        name: "max_iterations",
        required: false,
        description: "Per-process iteration cap (>= 1).",
      },
      {
        name: "iteration_delay_seconds",
        required: false,
        description: "Cooldown between iterations (>= 0).",
      },
      {
        name: "iteration_timeout_seconds",
        required: false,
        description: "Per-session timeout (>= 1).",
      },
      {
        name: "budget_usd",
        required: false,
        description: "Cumulative budget rail since the last enable (> 0).",
      },
      {
        name: "max_consecutive_failures",
        required: false,
        description: "Failure breaker (>= 1).",
      },
      {
        name: "max_blocked_on_human",
        required: false,
        description:
          "Consecutive sessions reporting outcome=blocked_on_human before the runner stops the loop with a reason naming the blocker (>= 0; 0 opts out — blocked_on_human then only parks).",
      },
      {
        name: "starvation_policy",
        required: false,
        description:
          '"park" (probe readiness, sleep free when nothing is actionable) or "always_run".',
      },
      {
        name: "loop_landing",
        required: false,
        description:
          '"human", "self_merge" (the loop agent merges its own PR — grants nothing) or "merge_queue" — the per-board opt-in for autonomous landing via the platform merge queue.',
      },
      {
        name: "merge_gate",
        required: false,
        description:
          '"forge_ci" requires forge CI green before the merge queue lands the PR; "none" merges without a CI gate.',
      },
      {
        name: "completion_query",
        required: false,
        description:
          'Declarative run-complete condition, {"label": ..., "exclude_column_type": "done"} — the runner evaluates it before each iteration and disables the loop itself when zero cards match, without spawning a session. It also verifies any session\'s objective_complete claim. Pass {} to clear it (omitting the field leaves it unchanged).',
      },
      {
        name: "skills_proposal_enabled",
        required: false,
        description:
          "Whether loop agents on this board may call propose_skill. Defaults to true (backend-enforced). When false the backend strips propose_skill from the loop's served tool allowlist. Omit to leave unchanged.",
      },
      {
        name: "relax_done_merge_gate",
        required: false,
        description:
          "Decline lever for the self_merge auto-relax: false keeps the board's done-merge gate armed on a save that lands on self_merge (the loop will then dead-end on its first Done move). Applies to that save only — never stored. The auto-relax itself fires only when loop_landing is passed in the same call; an inherited stored landing never relaxes. Omit to accept the default; only meaningful alongside other config fields.",
      },
      {
        name: "template_ref",
        required: false,
        description:
          "Bind the loop to a loop template — a system slug or a workspace template's row UUID. The board's prompts and tools become the render of that template and are owned by it.",
      },
      {
        name: "template_source",
        required: false,
        description: '"system" (default) or "workspace" — which namespace template_ref lives in.',
      },
      {
        name: "template_version",
        required: false,
        description: "Pin the bind to a specific published version. Omit to take the newest.",
      },
      {
        name: "slot_values",
        required: false,
        description:
          'Values for the template\'s <<SLOT>> placeholders, as {"SLOT_NAME": value}. FULL REPLACE. Sent alone (no template_ref) it re-renders the board\'s existing binding.',
      },
      {
        name: "detach_template",
        required: false,
        description:
          "True drops the binding and keeps the rendered prompts as plain editable text. Wins over template_ref if both are passed.",
      },
      {
        name: "expected_version",
        required: false,
        description:
          "Optimistic lock for the config PUT — the loop config version you last read. A concurrent edit makes this 409 rather than clobbering.",
      },
    ],
    gotchas: [
      "Omitted means unchanged: any config field you don't pass keeps its stored value. Config edits apply on the NEXT iteration.",
      "completion_query is how a curated run ends for free: zero matching cards disables the loop before any session is spawned, and refutes a session that claims objective_complete while cards remain.",
      "Idempotent — setting the current state is a no-op (no version bump).",
      "Enabling requires a configured non-empty loop_prompt; otherwise the backend rejects with 422.",
      "Passing nothing at all (no config field and no enabled flag) returns an error instead of a silent no-op.",
      "Config writes are last-write-wins — there is no optimistic lock, so coordinate prompt edits out of band.",
      "Requires member or better; runner keys inherit their creating user's role.",
      "Binding a template makes it own system_prompt/loop_prompt/tools: sending those in the same call is 422, and sending them later on a bound board is 409 (detach first with detach_template=true).",
      "slot_values is a FULL REPLACE of the binding's values — read them back with get_board_loop_binding_raw and send the whole object.",
    ],
    examplePrompt:
      "Using the Backplane MCP, stop the loop on the <board> board in <workspace> with the reason <reason>.",
    related: ["get_board_loop", "get_board", "get_board_loop_binding_raw", "list_loop_templates"],
  },
  {
    name: "delete_board",
    category: "boards",
    kind: "write",
    description:
      "Permanently delete a board and everything scoped to it. Use to tear down finished or sandbox boards — verify the id with list_boards first.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
    ],
    danger:
      "Irreversible cascade: deletes the board's columns, cards (with their participants and dependencies), notes, definition, git-repo bindings, and resources in one call. No undo.",
    gotchas: [
      "board_id accepts a slug too — confirm what it resolves to before deleting.",
      "Activity and execution history survive but are unlinked from the board.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the boards in <workspace>, confirm with me which one is <board>, and only then delete it with delete_board.",
    related: ["list_boards", "get_board", "update_board"],
  },

  // ── Columns ───────────────────────────────────────────────────────────────
  {
    name: "create_column",
    category: "columns",
    kind: "write",
    description:
      "Add a column to the end of a board. Set column_type so runner pipelines can discover the column and route cards through it.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "name",
        required: true,
        description: "Display name for the column.",
      },
      {
        name: "column_type",
        required: false,
        description: "Semantic type: backlog, active, review, done, or blocked.",
      },
      {
        name: "color",
        required: false,
        description: "Hex color string for the column header.",
      },
    ],
    gotchas: [
      "Runners resolve pipeline stages by column_type, never by column name — a column without a type is a human-only zone they ignore.",
      "Interactive claims work by moving a card (move_card) into the column whose column_type matches the target stage, not by naming conventions.",
    ],
    examplePrompt:
      "Using the Backplane MCP, add a <Review> column with column_type review to the <board> board in <workspace>.",
    related: ["get_board", "update_column", "reorder_columns", "create_card"],
  },
  {
    name: "update_column",
    category: "columns",
    kind: "write",
    description:
      "Rename, recolor, or retype a column. Only fields you pass are changed; column_type controls whether runners see the column at all.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "column_id",
        required: true,
        description: "The UUID of the column to update.",
      },
      {
        name: "name",
        required: false,
        description: "New display name.",
      },
      {
        name: "color",
        required: false,
        description: "New hex color string for the header.",
      },
      {
        name: "column_type",
        required: false,
        description:
          'Semantic type: backlog, active, review, done, or blocked. Pass "null" or "none" to clear it.',
      },
    ],
    gotchas: [
      'Clearing the type takes the literal string "null" (or "none") — a cleared column becomes a human-only zone runners no longer discover cards in.',
      "Retyping changes which pipeline stage the column represents for runners — stages resolve by column_type, not name.",
    ],
    examplePrompt:
      "Using the Backplane MCP, set the column_type of the <column> column on the <board> board in <workspace> to blocked.",
    related: ["create_column", "delete_column", "get_board"],
  },
  {
    name: "delete_column",
    category: "columns",
    kind: "write",
    description:
      "Permanently delete a column together with every card inside it. Move cards you want to keep to another column first.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "column_id",
        required: true,
        description: "The UUID of the column to delete.",
      },
    ],
    danger:
      "Deletes ALL cards in the column along with it — including their participants and dependency edges. It does not reject non-empty columns; the cascade happens immediately, with no undo.",
    examplePrompt:
      "Using the Backplane MCP, check the <column> column on <board> in <workspace> with get_board; move any remaining cards to <other column> with move_card, then delete the column.",
    related: ["move_card", "get_board", "update_column"],
  },
  {
    name: "reorder_columns",
    category: "columns",
    kind: "write",
    description:
      "Set the left-to-right order of a board's columns by sending the complete ordered list of column ids.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "column_ids",
        required: true,
        description: "Every column UUID on the board, in the desired left-to-right order.",
      },
    ],
    gotchas: [
      "The backend does not validate the list: nonexistent ids are silently skipped, omitted columns keep their old positions, and ids are never checked against this board — a partial or mixed-up list yields an unpredictable order. Always send exactly this board's full column id list.",
    ],
    examplePrompt:
      "Using the Backplane MCP, get the <board> board in <workspace> and reorder its columns so <column> comes first.",
    related: ["get_board", "create_column", "update_column"],
  },
];
