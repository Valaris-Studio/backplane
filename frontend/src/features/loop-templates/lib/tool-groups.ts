// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tool grouping for the profile page's "Tools" section.
//
// The profile endpoint returns a FLAT `tools: string[]` — the backend grants
// tools, it does not classify them — so the read/write split is a client-side
// presentation concern and lives here, in one place, with a test.
//
// Classification is by VERB PREFIX rather than an exhaustive per-tool list: the
// MCP surface grows every loop, and a list would silently misfile each new tool
// as unknown. The prefixes are the server's own naming convention
// (mcp-server/@mcp.tool decorators), so a new `get_*` reads as read for free.

export type ToolGroup = "read" | "write" | "offSwitch";

// Render order. The off-switch goes LAST because it is the one grant an
// operator scans for when deciding whether a loop can stop itself.
export const TOOL_GROUP_ORDER = ["read", "write", "offSwitch"] as const;

// `set_board_loop` disables the loop — it is a mutation, but grouping it with
// ordinary writes buries the single most consequential grant on the page.
// Owner rule (card Direction): it is ALWAYS "off-switch".
const OFF_SWITCH_TOOLS = new Set(["set_board_loop"]);

const READ_PREFIXES = [
  "get_",
  "list_",
  "search_",
  "validate_",
  "export_",
  "whoami",
  "next_assignment",
];

export interface GroupedTools {
  read: string[];
  write: string[];
  offSwitch: string[];
}

export function classifyTool(name: string): ToolGroup {
  if (OFF_SWITCH_TOOLS.has(name)) return "offSwitch";
  // Unknown verbs fall through to "write": over-reporting a grant's blast
  // radius is the safe direction to be wrong in.
  return READ_PREFIXES.some((prefix) => name.startsWith(prefix))
    ? "read"
    : "write";
}

/** Group a template's tool grant, preserving the order the template listed. */
export function groupTools(tools: string[]): GroupedTools {
  const grouped: GroupedTools = { read: [], write: [], offSwitch: [] };
  for (const tool of tools) grouped[classifyTool(tool)].push(tool);
  return grouped;
}
