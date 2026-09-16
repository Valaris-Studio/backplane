// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tool catalog for the runner pipeline builder.
//
// Sources of truth:
//   - CLAUDE_BUILTINS: hand-maintained. These are tools the user's coding
//     agent (Claude Code, Codex) typically exposes by default. We list them so
//     operators can build stages that rely on file/web access without having
//     to know the string names, but the tools only actually exist at runtime
//     if the client is configured with them.
//   - VALARIS_MCP_TOOLS: every `@mcp.tool()` in mcp-server/src/valaris_mcp/tools/*.py.
//     A backend pytest (tests/test_mcp_catalog_drift.py) asserts this list
//     matches the decorated functions, so drift fails CI instead of silently
//     hiding tools from the UI.
//
// Tool ids are the raw strings the Go runner passes to `claude -p --allowedTools`.

export type ToolCategory = "claude_builtin" | "valaris_mcp" | "other";

export interface ToolEntry {
  id: string;
  label: string;
  summaryKey: string;
  category: ToolCategory;
}

export const CLAUDE_BUILTINS: ToolEntry[] = [
  { id: "Read", label: "Read", summaryKey: "toolCatalog.claudeBuiltins.Read.summary", category: "claude_builtin" },
  { id: "Write", label: "Write", summaryKey: "toolCatalog.claudeBuiltins.Write.summary", category: "claude_builtin" },
  { id: "Edit", label: "Edit", summaryKey: "toolCatalog.claudeBuiltins.Edit.summary", category: "claude_builtin" },
  { id: "MultiEdit", label: "MultiEdit", summaryKey: "toolCatalog.claudeBuiltins.MultiEdit.summary", category: "claude_builtin" },
  { id: "Bash", label: "Bash", summaryKey: "toolCatalog.claudeBuiltins.Bash.summary", category: "claude_builtin" },
  { id: "Glob", label: "Glob", summaryKey: "toolCatalog.claudeBuiltins.Glob.summary", category: "claude_builtin" },
  { id: "Grep", label: "Grep", summaryKey: "toolCatalog.claudeBuiltins.Grep.summary", category: "claude_builtin" },
  { id: "WebSearch", label: "WebSearch", summaryKey: "toolCatalog.claudeBuiltins.WebSearch.summary", category: "claude_builtin" },
  { id: "WebFetch", label: "WebFetch", summaryKey: "toolCatalog.claudeBuiltins.WebFetch.summary", category: "claude_builtin" },
  { id: "TodoWrite", label: "TodoWrite", summaryKey: "toolCatalog.claudeBuiltins.TodoWrite.summary", category: "claude_builtin" },
];

// Keep alphabetically sorted. The drift test compares as a sorted set.
const VALARIS_MCP_NAMES = [
  "activate_catalog_skill",
  "add_card_dependency",
  "add_card_participant",
  "add_team_member",
  "add_workspace_member",
  "apply_loop_template_fixes",
  "archive_loop_template",
  "bulk_create_cards",
  "bulk_set_card_dependencies",
  "cancel_execution",
  "cancel_merge_queue_entry",
  "create_agent",
  "create_board",
  "create_card",
  "create_channel",
  "create_column",
  "create_git_repo",
  "create_loop_template",
  "create_note",
  "create_prompt_config",
  "create_resource",
  "create_team",
  "create_webhook",
  "create_workspace",
  "deactivate_team",
  "decide_approval",
  "delete_board",
  "delete_card",
  "delete_channel",
  "delete_column",
  "enable_toolsets",
  "delete_git_repo",
  "delete_note",
  "delete_prompt_config",
  "delete_resource",
  "delete_workspace",
  "duplicate_loop_template",
  "enqueue_for_merge",
  "enqueue_pr_for_merge",
  "export_loop_template",
  "export_pipeline_bundle",
  "freeze_board",
  "get_agent",
  "get_agent_budget_status",
  "get_agent_config",
  "get_approval_status",
  "get_board",
  "get_board_health",
  "get_board_loop",
  "get_board_loop_binding_raw",
  "get_card",
  "get_card_dependency_status",
  "get_card_verdict",
  "get_completion_policy",
  "get_completion_status",
  "get_definition",
  "get_download_url",
  "get_loop_template",
  "get_merge_queue_entry",
  "get_note",
  "get_pipeline_sensors",
  "get_project_context",
  "get_prompt_config",
  "get_resource",
  "get_server_info",
  "get_skill",
  "get_team",
  "get_upload_url",
  "get_webhook",
  "get_workspace",
  "get_workspace_config",
  "get_workspace_metrics",
  "get_workspace_summary",
  "import_loop_template",
  "import_pipeline_bundle",
  "list_activity",
  "list_agents",
  "list_approvals",
  "list_boards",
  "list_card_dependencies",
  "list_cards",
  "list_channels",
  "list_executions",
  "list_git_repos",
  "list_loop_template_versions",
  "list_loop_templates",
  "list_merge_queue",
  "list_notes",
  "list_prompt_configs",
  "list_resources",
  "list_skill_bindings_raw",
  "list_skill_catalog",
  "list_skills",
  "list_teams",
  "list_webhooks",
  "list_workspace_members",
  "list_workspaces",
  "log_execution_start",
  "log_execution_update",
  "move_card",
  "next_assignment",
  "pause_agent",
  "propose_skill",
  "publish_loop_template",
  "remove_card_dependency",
  "remove_card_participant",
  "remove_skill_binding",
  "remove_team_member",
  "remove_workspace_member",
  "reorder_columns",
  "request_approval",
  "request_landing",
  "restart_agent",
  "restore_loop_template_version",
  "resume_agent",
  "resume_cost_breaker",
  "retry_completion",
  "rotate_agent_key",
  "search_cards",
  "set_board_loop",
  "set_skill_binding",
  "submit_completion_candidate",
  "unfreeze_board",
  "update_agent",
  "update_board",
  "update_card",
  "update_channel",
  "update_column",
  "update_definition",
  "update_git_repo",
  "update_loop_template",
  "update_note",
  "update_prompt_config",
  "update_resource",
  "update_team",
  "update_webhook",
  "update_workspace_config",
  "update_workspace_member",
  "validate_board_dependencies",
  "list_documentation",
  "read_documentation",
  "whoami",
] as const;

export const VALARIS_MCP_TOOL_NAMES: readonly string[] = VALARIS_MCP_NAMES;

export const VALARIS_MCP_TOOLS: ToolEntry[] = VALARIS_MCP_NAMES.map((name) => ({
  id: `mcp__valaris__${name}`,
  label: name,
  summaryKey: `toolCatalog.valarisMcp.${name}.summary`,
  category: "valaris_mcp" as const,
}));

export const ALL_KNOWN_TOOLS: ToolEntry[] = [
  ...CLAUDE_BUILTINS,
  ...VALARIS_MCP_TOOLS,
];

const KNOWN_TOOLS_BY_ID = new Map(ALL_KNOWN_TOOLS.map((t) => [t.id, t]));

export function lookupTool(id: string): ToolEntry | undefined {
  return KNOWN_TOOLS_BY_ID.get(id);
}

export function categorizeTool(id: string): ToolCategory {
  return KNOWN_TOOLS_BY_ID.get(id)?.category ?? "other";
}
