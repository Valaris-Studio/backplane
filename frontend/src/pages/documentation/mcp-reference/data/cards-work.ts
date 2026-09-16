// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: cards, bulk, search, assignments.
export const CARDS_WORK_TOOL_DOCS: ToolDoc[] = [
  {
    name: "list_cards",
    category: "cards",
    kind: "read",
    description:
      "List every card on a board grouped by column. Use for a full-board snapshot; prefer search_cards when you only need a filtered subset.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
    ],
    gotchas: [
      "Fetches the entire board detail under the hood — on large boards this is a heavy response; filter with search_cards instead.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list all cards on the <board> board in the <workspace> workspace and give me a per-column count with any urgent cards called out.",
    related: ["search_cards", "get_card", "get_board", "create_card"],
  },
  {
    name: "get_card",
    category: "cards",
    kind: "read",
    description:
      "Fetch one card with full details and participants. Accepts a full UUID or a short id prefix (4+ chars) from a note or standup — the server resolves it.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board containing the card.",
      },
      {
        name: "card_id",
        required: true,
        description: "The card's full UUID, or a unique short id prefix (at least 4 characters).",
      },
    ],
    gotchas: [
      "Anything shorter than a full 36-char UUID is treated as a prefix and resolved against this board only.",
      "An ambiguous prefix returns an error listing the candidate cards — retry with more characters.",
    ],
    examplePrompt:
      "Using the Backplane MCP, look up card <short-id> on the <board> board in <workspace> with get_card and summarize its status, participants, and description.",
    related: ["search_cards", "update_card", "move_card", "get_card_dependency_status"],
  },
  {
    name: "create_card",
    category: "cards",
    kind: "write",
    description:
      "Create a single card in a chosen column. Use when adding one piece of work; for turning a plan into many cards use bulk_create_cards.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "column_id",
        required: true,
        description: "UUID of the column to place the card in.",
      },
      {
        name: "title",
        required: true,
        description: "Card title. Max 500 characters.",
      },
      {
        name: "description",
        required: false,
        description: "Card description (supports rich text). Defaults to empty.",
      },
      {
        name: "card_type",
        required: false,
        description: "One of task, issue, feature, bug. Defaults to task.",
      },
      {
        name: "priority",
        required: false,
        description: "One of none, low, medium, high, urgent. Defaults to none.",
      },
      {
        name: "due_date",
        required: false,
        description: "Due date in YYYY-MM-DD format.",
      },
      {
        name: "status",
        required: false,
        description:
          "Free-form status string. Max 255 characters — a short state label, not prose.",
      },
      { name: "labels", required: false, description: "List of label strings." },
      {
        name: "git_repo_slug",
        required: false,
        description:
          "On multi-repo boards, the slug of the repo this card targets. Omit on single-repo boards to use the board's primary repo.",
      },
    ],
    gotchas: [
      "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.",
      "NOT idempotent: cards have no unique slug, so a retried call mints a duplicate card. Search for an existing card before re-creating.",
      "git_repo_slug only matters on multi-repo boards; omitting it falls back to the board's primary repo.",
      "An unknown git_repo_slug is silently dropped (never a 422) — the board's primary repo applies and the drop is recorded in the activity feed.",
    ],
    examplePrompt:
      "Using the Backplane MCP, create a high-priority bug card titled <title> in the backlog column of the <board> board in <workspace>, with a short description of the symptom.",
    related: ["bulk_create_cards", "update_card", "add_card_dependency", "search_cards"],
  },
  {
    name: "update_card",
    category: "cards",
    kind: "write",
    description:
      "Change fields on an existing card — title, description, priority, labels, due date, and more. Use for edits; moving between columns is move_card.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card to update, or a unique id prefix (≥4 chars).",
      },
      {
        name: "title",
        required: false,
        description: "New card title. Max 500 characters.",
      },
      { name: "description", required: false, description: "New description." },
      {
        name: "card_type",
        required: false,
        description: "New type: task, issue, feature, or bug.",
      },
      {
        name: "priority",
        required: false,
        description: "New priority: none, low, medium, high, or urgent.",
      },
      {
        name: "due_date",
        required: false,
        description: "New due date in YYYY-MM-DD format.",
      },
      {
        name: "status",
        required: false,
        description:
          "New status string. Max 255 characters — a short state label, not prose.",
      },
      {
        name: "labels",
        required: false,
        description: "New list of label strings — replaces the existing list.",
      },
      {
        name: "pr_url",
        required: false,
        description:
          "URL of the pull request this card shipped as — a first-class field, not a link in the description.",
      },
      {
        name: "branch_name",
        required: false,
        description: "Name of the branch the card's work landed on.",
      },
      {
        name: "git_repo_slug",
        required: false,
        description: "On multi-repo boards, the slug of the repo this card targets.",
      },
      {
        name: "clear_fields",
        required: false,
        description: "Set these nullable fields to null: due_date, status, labels, pr_url, branch_name, git_repo_slug. For example, clear_fields=[\"due_date\"].",
      },
    ],
    gotchas: [
      "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.",
      "Omitted fields and explicit null values keep their current values. Use clear_fields to remove nullable values; setting and clearing the same field is rejected. Use description=\"\" to clear a description, and labels=[] for an empty label list.",
      "labels REPLACES the whole list; to add one label, send the existing labels plus the new one.",
      "pr_url and branch_name are update-only — create_card has no equivalent, because the backend's create schema does not accept them.",
      "An unrecognised field name is rejected with a 422 naming it, not silently ignored — a misspelling fails loudly instead of costing you the write.",
    ],
    examplePrompt:
      "Using the Backplane MCP, find the card about <topic> on the <board> board in <workspace> and update its priority to urgent, adding the label <label> without dropping existing labels.",
    related: ["get_card", "move_card", "create_card"],
  },
  {
    name: "delete_card",
    category: "cards",
    kind: "write",
    description:
      "Permanently delete a card. Use only for mistakes or truly obsolete items — finished work should instead be moved to the done column.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card to delete, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "Permanent — there is no undo or archive. Confirm with get_card before deleting.",
    ],
    examplePrompt:
      "Using the Backplane MCP, delete the duplicate card <card-id> from the <board> board in <workspace>. Show me the card first so I can confirm it is the right one.",
    related: ["get_card", "search_cards", "update_card"],
  },
  {
    name: "move_card",
    category: "cards",
    kind: "write",
    description:
      "Move a card to another column and/or reorder it within one. This is how humans and interactive agents progress work through the board lifecycle.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card to move, or a unique id prefix (≥4 chars).",
      },
      { name: "column_id", required: true, description: "UUID of the target column." },
      {
        name: "position",
        required: false,
        description:
          "Optional fractional position within the target column (a float). Omit it to append the card to the end of the column.",
      },
    ],
    gotchas: [
      "Omit position for a plain column move — the server appends the card (max position + 1024). Pass a float only when the ordering matters: it is a fractional index, so use the midpoint between neighbors.",
      "card_id accepts a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.",
      "Pick the target column by its column_type (backlog/active/review/done/blocked), never by its display name.",
      "A same-column move that changes position by less than 1.0 is silently treated as a no-op.",
      "Runner-authenticated moves into a done-typed column hit the merge gate: 422 if the card's description has no PR URL, 409 if the PR is unmerged or lacks an approving reviewer verdict. Human sessions skip the gate.",
      "Interactively claiming a card = move_card to the active column + add_card_participant; runners use next_assignment instead.",
    ],
    examplePrompt:
      "Using the Backplane MCP, move the card about <topic> on the <board> board in <workspace> to the column whose type is review, placing it at the top of the column.",
    related: ["add_card_participant", "get_board", "update_card", "next_assignment"],
  },
  {
    name: "add_card_participant",
    category: "cards",
    kind: "write",
    description:
      "Add a person or agent to a card with a display role (hero = responsible). Pair with move_card when interactively claiming a card.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card, or a unique id prefix (≥4 chars).",
      },
      { name: "user_id", required: true, description: "UUID of the user or agent to add." },
      {
        name: "role",
        required: false,
        description: "Display role: hero (responsible), viewer, stakeholder, or helper. Defaults to hero.",
      },
      {
        name: "pipeline_role",
        required: false,
        description:
          "Pipeline-stage role string (max 64 chars), e.g. planner or implementer — set when claiming on behalf of a pipeline stage.",
      },
    ],
    gotchas: [
      "Idempotent: adding an existing participant returns the card instead of erroring, so retries are safe.",
      "A card has at most one hero — adding a different user with role hero returns 409 (already_claimed).",
      "On an existing participant row, a NULL pipeline_role is backfilled in place, but a conflicting non-NULL value is preserved (not overwritten).",
    ],
    examplePrompt:
      "Using the Backplane MCP, add <user-email-or-id> as the hero on the card about <topic> on the <board> board in <workspace>, then move it to the active column.",
    related: ["move_card", "remove_card_participant", "list_workspace_members"],
  },
  {
    name: "remove_card_participant",
    category: "cards",
    kind: "write",
    description:
      "Remove participants from a card: one person by user_id, or every holder of a pipeline_role. Use on rework to clear the stale implementer before it is re-claimed.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card, or a unique id prefix (≥4 chars).",
      },
      {
        name: "user_id",
        required: false,
        description:
          "UUID of the one participant to remove. Pass this or pipeline_role, never both.",
      },
      {
        name: "pipeline_role",
        required: false,
        description:
          "Pipeline-stage role to clear instead of user_id: planner, implementer, reviewer, rework_mediator, or any custom role. Every holder is removed.",
      },
    ],
    gotchas: [
      "Exactly one selector: pass user_id or pipeline_role — neither or both is rejected before any request is sent.",
      "pipeline_role removes every participant holding that role, and matches the pipeline_role field, not the display role (hero/viewer/stakeholder/helper).",
      "Idempotent: removing a user who is not a participant, or clearing a role nobody holds, succeeds as a no-op.",
      "On rework, clear the stale implementer by pipeline_role rather than user_id — in multi-runner deployments the implementer is a different user than the mediator.",
    ],
    examplePrompt:
      "Using the Backplane MCP, the card <card-id> on the <board> board in <workspace> is going back for rework — clear its implementer participants by pipeline_role so a fresh implementer can re-claim it.",
    related: ["add_card_participant", "get_card", "next_assignment", "move_card"],
  },
  {
    name: "bulk_create_cards",
    category: "bulk",
    kind: "composite",
    description:
      "Create up to 50 cards on one board in a single call. Use when turning a plan or backlog list into cards instead of looping create_card.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "cards",
        required: true,
        description:
          "List of card objects. Each needs column_id and title; optional: description, card_type, priority, due_date, status, labels and git_repo_slug.",
      },
    ],
    gotchas: [
      "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.",
      "Hard cap of 50 cards per request — split larger plans into batches.",
      "All-or-nothing: one invalid column_id rejects the entire batch.",
      "NOT idempotent: like create_card, a retried batch creates duplicates.",
      "git_repo_slug is preserved for each card. An unknown slug or a repository outside this board rejects the entire batch with 422; no cards are created. This does not change the historical create_card fallback.",
    ],
    examplePrompt:
      "Using the Backplane MCP, break the plan in <plan-note> into cards and create them all at once with bulk_create_cards in the backlog column of the <board> board in <workspace>.",
    related: ["create_card", "bulk_set_card_dependencies", "get_board"],
  },
  {
    name: "search_cards",
    category: "search",
    kind: "read",
    description:
      "Find cards on a board by text, priority, type, status, label, assignee, column, or overdue state. Use instead of list_cards whenever you need a subset.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "UUID of the board." },
      {
        name: "q",
        required: false,
        description: "Text to search in card titles and descriptions.",
      },
      {
        name: "priority",
        required: false,
        description: "Filter by priority: none, low, medium, high, urgent.",
      },
      {
        name: "card_type",
        required: false,
        description: "Filter by type: task, issue, feature, bug.",
      },
      { name: "status", required: false, description: "Filter by status string." },
      {
        name: "label",
        required: false,
        description: "Filter to cards carrying this label.",
      },
      {
        name: "has_assignee",
        required: false,
        description:
          "True for cards with a hero, False for cards with no hero (helpers/viewers don't count as assigned).",
      },
      {
        name: "assignee_id",
        required: false,
        description: "Filter to cards where this user/agent UUID is a participant.",
      },
      {
        name: "column_id",
        required: false,
        description: "Filter to a specific column UUID.",
      },
      {
        name: "column_type",
        required: false,
        description: "Filter by semantic column type: backlog, active, review, done, blocked.",
      },
      {
        name: "exclude_column_type",
        required: false,
        description: "Exclude cards in columns of this semantic type.",
      },
      {
        name: "include_untyped",
        required: false,
        description:
          "Include cards from untyped (human-only) columns. Default true; autonomous runners must pass false to keep human parking zones out of pickup scans.",
      },
      {
        name: "overdue",
        required: false,
        description: "True for cards past their due date.",
      },
      {
        name: "summary_only",
        required: false,
        description:
          "Return compact cards — id, title, column_id, column_name, column_type, labels, priority, status, card_type only. Recommended for browse and triage queries; full responses carry every description and participant list.",
      },
      {
        name: "limit",
        required: false,
        description: "Maximum results, 1-100. Defaults to 50.",
      },
    ],
    gotchas: [
      "Untyped-column cards (human scratchpad zones) are INCLUDED by default. Autonomous runners picking up work must pass include_untyped=false — those cards were deliberately parked by a human. User-facing reports can omit the flag.",
      "Full responses include every matched card's description, so a broad label or text query on a busy board can overflow the tool-result token budget. Pass summary_only=true to browse, then get_card for the one you need.",
    ],
    examplePrompt:
      "Using the Backplane MCP, search the <board> board in <workspace> for overdue high-priority cards without an assignee, including untyped columns, and summarize what is at risk.",
    related: ["list_cards", "get_card", "next_assignment"],
  },
  {
    name: "next_assignment",
    category: "assignments",
    kind: "composite",
    description:
      "Reserve the next eligible card for a runner — the pickup path. The backend applies all role filters and returns the card with its work context.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace to scan for eligible work.",
      },
      { name: "agent_id", required: true, description: "UUID of the runner requesting work." },
      {
        name: "role_override",
        required: false,
        description:
          "Request a specific role instead of the runner's primary role; must be a role the runner holds in its team.",
      },
      {
        name: "board_id",
        required: false,
        description: "Restrict the scan to one board UUID. Defaults to all boards the runner can access.",
      },
    ],
    gotchas: [
      "Returns a bundle: reserved card + board, column, repo, default branch, effective role, stage_action verb, and a TTL'd reservation — no follow-up fetches needed to start work.",
      'A {"status": "no_work"} response is normal, not an error — sleep 60-120s and retry.',
      "Idempotent while your reservation is active: repeated calls return the same card. The reservation auto-expires, so a crashed runner cannot starve the board.",
      "409 means the runner already has an in-flight execution on a different card (response carries active_card_id and execution_id) — finish or cancel that first.",
      "A paused runner gets no_work rather than an error; 423 means the workspace cost circuit breaker tripped — no cards are handed out until it clears.",
    ],
    examplePrompt:
      "Using the Backplane MCP, call next_assignment for runner <agent-id> in the <workspace> workspace. If a card is reserved, start an execution with the returned stage_action; if no_work, tell me and stop.",
    related: ["log_execution_start", "get_card", "get_agent_config"],
  },
];
