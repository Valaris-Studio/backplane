// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PromptDoc, ResourceDoc } from "./types";

// Every `@mcp.prompt()` in mcp-server/src/valaris_mcp/prompts.py, in pipeline
// order. Two CI links guard drift: a backend pytest
// (tests/test_mcp_catalog_drift.py) asserts this list matches the decorated
// functions, and __tests__/promptDocs.parity.test.ts pins the rendered
// PROMPT_DOCS below to this list.
export const PROMPT_NAMES = [
  "init_project",
  "standup",
  "triage",
  "status",
  "plan_work",
  "decompose_card",
  "sprint",
  "pickup",
  "implement",
  "ship",
] as const;

export const PROMPT_DOCS: PromptDoc[] = [
  {
    name: "init_project",
    role: "initializer",
    description:
      "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace the new board will live in.",
      },
      {
        name: "project_brief",
        required: true,
        description:
          "Free-text brief: goals, tech stack, constraints, timeline, team, and repos — everything the agent should extract and scaffold from.",
      },
    ],
    examplePrompt:
      "Use the Backplane init_project prompt for the <workspace> workspace with this brief: <paste your project brief>. Build the board end to end and show me the final verification summary.",
  },
  {
    name: "standup",
    role: "secretary",
    description:
      "Generate a daily standup for one board — progress, stale and overdue cards, bottlenecks — saved as a board note. Run each morning or before a team sync.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board to report on.",
      },
    ],
    examplePrompt:
      "Run the standup prompt for board <board_id> in the <workspace> workspace. Post the report as a board note, but don't touch any cards unless I say so.",
  },
  {
    name: "triage",
    role: "secretary",
    description:
      "Audit board hygiene — missing priorities, empty descriptions, overdue or stale cards — into a health score with proposed fixes. Fixes run only after you confirm.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board to health-check.",
      },
    ],
    examplePrompt:
      "Use the triage prompt on board <board_id> in the <workspace> workspace. Show me the health score and the issue list, then wait for my go-ahead before fixing anything.",
  },
  {
    name: "status",
    role: "secretary",
    description:
      "Summarize every board in a workspace: completion, urgent and overdue counts, stalled boards, plus the top 3 recommended actions. Use for a weekly or executive overview.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace to summarize across all of its boards.",
      },
    ],
    examplePrompt:
      "Run the status prompt for the <workspace> workspace and give me the cross-board health table plus your top three recommended actions.",
  },
  {
    name: "plan_work",
    role: "architect",
    description:
      "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board where the cards will be created.",
      },
      {
        name: "objective",
        required: true,
        description: "The high-level objective to break down into cards.",
      },
    ],
    examplePrompt:
      "Use the plan_work prompt on board <board_id> in <workspace> with the objective: <objective>. Show me the sequenced plan before creating any cards.",
  },
  {
    name: "decompose_card",
    role: "architect",
    description:
      "Split one oversized card into smaller, independently deliverable child cards that inherit its labels and priority. Use when a card is too big for 1-3 days of work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board the card lives on.",
      },
      {
        name: "card_id",
        required: true,
        description: "ID of the oversized card to split.",
      },
    ],
    examplePrompt:
      "Run decompose_card on card <card_id> (board <board_id>, workspace <workspace>). Propose the split first, and don't delete the parent card without asking me.",
  },
  {
    name: "sprint",
    role: "architect",
    description:
      "Plan a sprint: measure velocity, select backlog cards within capacity, stage them in the sprint column with due dates and owners, and pin a sprint-plan note.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board to plan the sprint on.",
      },
    ],
    examplePrompt:
      "Use the sprint prompt for board <board_id> in <workspace>. Show me the selected-cards table before moving anything, then document the plan as a pinned note.",
  },
  {
    name: "pickup",
    role: "coder",
    description:
      "Claim a card interactively: pick from the backlog-typed column, move it into the active-typed column, and output an implementation brief. Runners use next_assignment.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board to pick up work from.",
      },
      {
        name: "card_id",
        required: false,
        description:
          "Card to pick up. Omit to auto-select the highest-priority unassigned card in the backlog-typed column (resolved by column_type, never by column name). If no column on the board has a column_type, the prompt first types the columns via update_column rather than guessing by name.",
      },
    ],
    examplePrompt:
      "Use the pickup prompt on board <board_id> in <workspace> — pick the best available card for me, claim it by moving it into the working column, and give me the implementation brief.",
  },
  {
    name: "implement",
    role: "coder",
    description:
      "Run the full delivery loop for one card: claim it, plan against the codebase, implement with strict TDD, verify, then move it to review with an implementation record.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board the card lives on.",
      },
      {
        name: "card_id",
        required: true,
        description: "ID of the card to implement.",
      },
    ],
    examplePrompt:
      "Run the implement prompt for card <card_id> on board <board_id> in <workspace>. Follow the TDD loop and show me your implementation plan before writing code.",
  },
  {
    name: "ship",
    role: "coder",
    description:
      "Close out a reviewed card: move it to Done, mark it completed, write a completion note, report newly unblocked cards, and suggest the next card to pick up.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Slug of the workspace that owns the board.",
      },
      {
        name: "board_id",
        required: true,
        description: "ID of the board the card lives on.",
      },
      {
        name: "card_id",
        required: true,
        description: "ID of the reviewed card to complete.",
      },
    ],
    examplePrompt:
      "Use the ship prompt for card <card_id> on board <board_id> in <workspace>. Complete it, record the completion note, and tell me what it unblocked and what to pick up next.",
  },
];

// Mirrors the `@mcp.resource()` registrations in
// mcp-server/src/valaris_mcp/resources.py. The backend catalog drift test pins
// these URIs alongside tool and prompt names; frontend signature parity covers
// tool and prompt parameters.
export const RESOURCE_DOCS: ResourceDoc[] = [
  {
    uri: "valaris://workspaces",
    description:
      "List of all workspaces you can access, with slugs and metadata. Read this first to discover the workspace_slug that every other call needs.",
  },
  {
    uri: "valaris://workspace/{workspace_slug}/summary",
    description:
      "Aggregate stats for one workspace: board, card, note, and channel counts plus recent activity. Same data as the get_workspace_summary tool.",
  },
  {
    uri: "valaris://workspace/{workspace_slug}/board/{board_id}/definition",
    description:
      "The board's definition document: scope plus structured content (objectives, tech stack, milestones, constraints). Same data as the get_definition tool.",
  },
];
