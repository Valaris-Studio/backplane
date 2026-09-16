// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CategoryDef, CategoryId } from "./types";

// Sidebar/group ordering for the MCP reference. Categories render grouped in
// this order; within a group, registry order below wins.
export const GROUPS = [
  "Start here",
  "Work management",
  "Knowledge & content",
  "Collaboration",
  "Autonomous operations",
] as const;

export type GroupName = (typeof GROUPS)[number];

// Same rule as mcp-server catalog.slugify: lowercase, runs of non-alphanumerics
// become "-", leading/trailing "-" trimmed.
export function slugifyGroup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Group toolset ids, in GROUPS order. Kept as a literal (not derived) because
// the server-side parity test regex-parses this list; serverSurface.parity
// pins it equal to GROUPS.map(slugifyGroup).
export const GROUP_IDS = [
  "start-here",
  "work-management",
  "knowledge-content",
  "collaboration",
  "autonomous-operations",
] as const;

export type GroupId = (typeof GROUP_IDS)[number];

// Category ids are law: ToolDoc.category must be one of these. `CategoryId` in
// types.ts is derived from this literal, so adding a category here is the only
// change needed to make it assignable.
export const CATEGORIES = [
  {
    id: "context",
    title: "Project Context",
    group: "Start here",
    blurb: "One-call project briefings: definition, summary, notes, repos, and activity.",
  },
  {
    id: "search",
    title: "Search",
    group: "Start here",
    blurb: "Find cards by text, filters, or short id prefix without walking the board.",
  },
  {
    id: "assignments",
    title: "Assignments",
    group: "Start here",
    blurb: "Backend-scheduled work pickup: reserve the next eligible card for a role.",
  },
  {
    id: "bulk",
    title: "Bulk Operations",
    group: "Start here",
    blurb: "Create many cards or dependency edges in a single call.",
  },
  {
    id: "health",
    title: "Board Health",
    group: "Start here",
    blurb: "Board-level diagnostics: stalls, dependency validity, and pipeline sensors.",
  },
  {
    id: "server-info",
    title: "Server Info",
    group: "Start here",
    blurb: "Who am I and what does this server expose: identity, version, tool allowlist.",
  },
  {
    id: "workspaces",
    title: "Workspaces",
    group: "Work management",
    blurb: "Top-level tenancy: workspaces, their members, and summaries.",
  },
  {
    id: "boards",
    title: "Boards",
    group: "Work management",
    blurb: "Projects inside a workspace: create, read, update, delete boards.",
  },
  {
    id: "columns",
    title: "Columns",
    group: "Work management",
    blurb: "Board lifecycle stages: column CRUD and ordering.",
  },
  {
    id: "cards",
    title: "Cards",
    group: "Work management",
    blurb: "The unit of work: card CRUD, movement, and participants.",
  },
  {
    id: "card-dependencies",
    title: "Card Dependencies",
    group: "Work management",
    blurb: "Blocking edges between cards: add, remove, inspect done-state.",
  },
  {
    id: "notes",
    title: "Notes",
    group: "Knowledge & content",
    blurb: "Rich-text knowledge attached to workspaces and boards.",
  },
  {
    id: "definitions",
    title: "Definitions",
    group: "Knowledge & content",
    blurb: "The board's contract: goals, conventions, and context agents read first.",
  },
  {
    id: "resources",
    title: "Resources",
    group: "Knowledge & content",
    blurb: "Files and links: upload, download, and manage attachments.",
  },
  {
    id: "activity",
    title: "Activity",
    group: "Knowledge & content",
    blurb: "The audit trail: who changed what, when.",
  },
  {
    id: "teams",
    title: "Teams",
    group: "Collaboration",
    blurb: "Named groups of people and runners with roles.",
  },
  {
    id: "channels",
    title: "Channels",
    group: "Collaboration",
    blurb: "Contact points (Slack, email, webhooks) bound to a workspace.",
  },
  {
    id: "git-repos",
    title: "Git Repos",
    group: "Collaboration",
    blurb: "Repository bindings that let cards target real branches and PRs.",
  },
  {
    id: "webhooks",
    title: "Webhooks",
    group: "Collaboration",
    blurb: "Outbound event subscriptions for external integrations.",
  },
  {
    id: "agents-executions",
    title: "Agents & Executions",
    group: "Autonomous operations",
    blurb: "Runners and their execution logs: register, configure, observe, cancel.",
  },
  {
    id: "approvals",
    title: "Approvals",
    group: "Autonomous operations",
    blurb: "Human-in-the-loop gates: request, inspect, and decide approvals.",
  },
  {
    id: "merge-queue",
    title: "Merge Queue",
    group: "Autonomous operations",
    blurb: "Serialized PR landing: enqueue, inspect, and cancel merge entries.",
  },
  {
    id: "workspace-config",
    title: "Workspace Config",
    group: "Autonomous operations",
    blurb: "Pipeline roles, lifecycles, and guardrails, plus import/export bundles.",
  },
  {
    id: "prompt-configs",
    title: "Prompt Configs",
    group: "Autonomous operations",
    blurb: "Stored per-role prompt overrides for runner stages.",
  },
  {
    id: "loop-templates",
    title: "Loop Templates",
    group: "Autonomous operations",
    blurb:
      "Reusable loop definitions: catalog, drafts and versions, plus what a board's loop is bound to.",
  },
  {
    id: "skills",
    title: "Skills",
    group: "Autonomous operations",
    blurb: "The workspace skill library and per-board bindings: agents fetch skill files verbatim.",
  },
] as const;

export const CATEGORIES_BY_ID: ReadonlyMap<CategoryId, CategoryDef> = new Map(
  CATEGORIES.map((c): [CategoryId, CategoryDef] => [c.id, c]),
);
