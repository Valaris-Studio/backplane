// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: agents-executions, activity, server-info.
export const AGENTS_OBSERVABILITY_TOOL_DOCS: ToolDoc[] = [
  // ── agents-executions ──────────────────────────────────────────────
  {
    name: "get_agent_config",
    category: "agents-executions",
    kind: "read",
    description:
      "Get the runner identity linked to the current API key (vs whoami, which is the calling user). Use at session start to discover your agent_id and constraints.",
    params: [],
    gotchas: [
      "Distinct from whoami: whoami returns the calling user; get_agent_config returns the runner bound to the API key.",
      "Falls back to the user identity when no runner is linked to the key — execution tracking and approvals need a linked runner.",
    ],
    examplePrompt:
      "Before we start the run, call get_agent_config to confirm which runner identity this API key maps to and that the <workspace> workspace is in its allowed list.",
    related: ["whoami", "log_execution_start", "get_server_info", "get_agent"],
  },
  {
    name: "create_agent",
    category: "agents-executions",
    kind: "write",
    description:
      "Register a runner identity (an agents row) with an API key, workspace allowlist, rate limit, and optional budget cap. Use when onboarding a new runner.",
    params: [
      { name: "name", required: true, description: "Runner display name." },
      {
        name: "agent_type",
        required: true,
        description: "One of 'coding', 'manager', 'reviewer', 'secretary', 'improver'.",
      },
      {
        name: "allowed_workspaces",
        required: true,
        description: "Workspace slugs the runner may access. Must contain at least one.",
      },
      { name: "description", required: false, description: "What this runner does." },
      {
        name: "allowed_actions",
        required: false,
        description: "Allowed action names; omit to allow all.",
      },
      {
        name: "max_requests_per_minute",
        required: false,
        description: "Rate limit (default 100).",
      },
      { name: "budget_usd", required: false, description: "Optional spending cap in USD." },
    ],
    gotchas: [
      "The raw_api_key in the response is shown exactly once — save it immediately.",
      "Re-creating an existing runner is idempotent but returns raw_api_key null (a lost key requires rotation) — and silently reactivates the runner if it had been deactivated.",
      "An empty allowed_workspaces makes the runner invisible to every workspace — list each workspace it must see.",
    ],
    examplePrompt:
      "Create a runner named '<name>' allowed in the <workspace> workspace with a $50 budget cap, then give me the API key so I can configure it.",
    related: ["get_agent", "update_agent", "add_team_member", "get_agent_config"],
  },
  {
    name: "get_agent",
    category: "agents-executions",
    kind: "read",
    description:
      "Fetch one runner's profile — type, allowlists, limits, budget, and active state. Use when auditing a runner or before updating it.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to retrieve." },
    ],
    gotchas: [
      "Never returns the API key — only its prefix. Raw keys are shown once, at create time.",
    ],
    examplePrompt:
      "Look up runner <agent-id> with get_agent and tell me its allowed workspaces, rate limit, and whether it is still active.",
    related: ["update_agent", "create_agent", "list_executions"],
  },
  {
    name: "update_agent",
    category: "agents-executions",
    kind: "write",
    description:
      "Change a runner's profile or guardrails — name, allowlists, rate limit, budget, active flag. Only passed fields change; hard_delete=true erases the runner instead.",
    danger:
      "hard_delete=true is irreversible. Unlike is_active=false, nothing survives to re-enable — the runner, its API key, executions, approvals and team memberships are gone.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to update." },
      { name: "name", required: false, description: "New display name." },
      { name: "description", required: false, description: "New description." },
      {
        name: "allowed_workspaces",
        required: false,
        description: "New workspace slug allowlist. Must be non-empty if provided.",
      },
      { name: "allowed_actions", required: false, description: "New action allowlist." },
      {
        name: "max_requests_per_minute",
        required: false,
        description: "New rate limit.",
      },
      { name: "budget_usd", required: false, description: "New spending cap in USD." },
      {
        name: "is_active",
        required: false,
        description: "Set false to disable the runner — the reversible retirement.",
      },
      {
        name: "hard_delete",
        required: false,
        description:
          "True permanently erases the runner — API key, executions, approvals, team memberships. Unrecoverable; must be the only field besides agent_id.",
      },
    ],
    gotchas: [
      "Changes apply on the runner's next config refresh (heartbeat cycle), not instantly.",
      "You cannot clear allowed_workspaces to empty — omit it to leave it unchanged.",
      "hard_delete=true accepts no other field — a call mixing edits with the erase is rejected before any request is sent.",
      "Refused with 409 while the runner has a card in flight — pause it and let the card finish, or cancel_execution first.",
      "Rejected for runner-linked API keys — a runner cannot erase itself or its peers.",
      "Prefer is_active=false for retirement; hard_delete exists to erase a runner that should never have existed.",
    ],
    examplePrompt:
      "Using update_agent, raise runner <agent-id>'s budget_usd to 100 and add the <workspace> workspace to its allowlist.",
    related: ["get_agent", "create_agent", "get_agent_config", "pause_agent"],
  },
  {
    name: "list_agents",
    category: "agents-executions",
    kind: "read",
    description:
      "List the runner identities you can administer, with active and paused state. The operator's inventory call — start here for the agent_id other lifecycle tools take.",
    params: [
      {
        name: "include_inactive",
        required: false,
        description: "Also return deactivated runners; defaults to active only.",
      },
    ],
    gotchas: [
      "Returns only runners the calling user administers — an empty list can mean no permission, not no runners.",
      "Never returns API keys, only their prefixes.",
    ],
    examplePrompt:
      "List the runners with list_agents and tell me which ones are currently paused.",
    related: ["get_agent", "pause_agent", "get_agent_budget_status", "create_agent"],
  },
  {
    name: "pause_agent",
    category: "agents-executions",
    kind: "write",
    description:
      "Stop a runner from picking up new cards — the primary runaway containment lever. Use the moment a runner looks stuck in a money-loop.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to pause." },
    ],
    gotchas: [
      "In-flight work is not killed — the runner finishes its current card and then idles, so spend stops after at most one more card. Pair with cancel_execution to end the running one.",
      "Idempotent: pausing an already-paused runner succeeds.",
      "Rejected for runner-linked API keys — a runner cannot pause itself or its peers; call it with an operator identity.",
    ],
    examplePrompt:
      "Runner <agent-id> keeps re-running the same card. Pause it with pause_agent and show me its budget status.",
    related: ["resume_agent", "get_agent_budget_status", "cancel_execution", "list_agents"],
  },
  {
    name: "resume_agent",
    category: "agents-executions",
    kind: "write",
    description:
      "Re-enable card pickup for a paused runner. Use once the condition that caused the pause is resolved.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to resume." },
    ],
    gotchas: [
      "Idempotent: resuming an active runner succeeds and changes nothing.",
      "Resuming a runner that was paused for overspend restarts the burn — check get_agent_budget_status first.",
      "Rejected for runner-linked API keys; call it with an operator identity.",
    ],
    examplePrompt:
      "The budget cap on runner <agent-id> has been raised — resume it with resume_agent.",
    related: ["pause_agent", "get_agent_budget_status", "update_agent", "list_agents"],
  },
  {
    name: "restart_agent",
    category: "agents-executions",
    kind: "write",
    description:
      "Ask a running runner to finish its in-flight card and exit, so its supervisor relaunches it on fresh platform config.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to restart." },
    ],
    gotchas: [
      "Requires a live WebSocket connection — an offline runner returns 503 rather than queueing the restart for later.",
      "The platform only asks; bringing the process back is the supervisor's job. On a hand-launched runner this is a stop, not a restart.",
      "In-flight work is not killed — the current card finishes first, so the exit can be minutes away.",
      "Rejected for runner-linked API keys — a runner restarting itself is a loop an operator cannot interrupt.",
    ],
    examplePrompt:
      "Runner <agent-id> is running stale pipeline config. Restart it with restart_agent, then confirm it reconnected with list_agents.",
    related: ["pause_agent", "list_agents", "get_agent", "update_agent"],
  },
  {
    name: "get_agent_budget_status",
    category: "agents-executions",
    kind: "read",
    description:
      "Check one runner's spend against its budget cap. The per-runner spend audit that pairs with pause_agent when containing a runaway.",
    params: [
      { name: "agent_id", required: true, description: "UUID of the runner to check." },
    ],
    gotchas: [
      "Per-runner only. For workspace-wide cost and per-card spend use get_workspace_metrics(view='cost').",
      "A runner with no budget_usd set has no cap to report against — it will never self-limit.",
    ],
    examplePrompt:
      "How much of its budget has runner <agent-id> burned? Use get_agent_budget_status.",
    related: ["get_workspace_metrics", "pause_agent", "update_agent", "get_agent"],
  },
  {
    name: "rotate_agent_key",
    category: "agents-executions",
    kind: "write",
    description:
      "Mint a new API key for a runner and invalidate the old one. The response to a leaked or compromised runner key.",
    params: [
      {
        name: "agent_id",
        required: true,
        description: "UUID of the runner whose key is being rotated.",
      },
    ],
    gotchas: [
      "The new raw_api_key is shown exactly once in the result — save it immediately; a lost key needs another rotation.",
      "The old key stops authenticating the moment this returns, so a runner mid-card fails until reconfigured. Pause it first if the timing matters.",
      "Rejected for runner-linked API keys; call it with an operator identity.",
    ],
    examplePrompt:
      "The key for runner <agent-id> was committed to a public repo. Pause the runner, rotate its key with rotate_agent_key, and give me the new one.",
    related: ["pause_agent", "create_agent", "get_agent", "list_agents"],
  },
  {
    name: "log_execution_start",
    category: "agents-executions",
    kind: "write",
    description:
      "Open an execution audit record for a runner's run and get back an execution_id. Call at the start of any agentic workflow you want tracked on the platform.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Workspace slug where this execution occurs.",
      },
      {
        name: "agent_id",
        required: true,
        description: "UUID of the runner starting the run (see get_agent_config).",
      },
      {
        name: "action",
        required: true,
        description: "Short action name, e.g. 'standup', 'tdd_implement', 'review_pr'.",
      },
      {
        name: "input_summary",
        required: true,
        description: "One-line summary of what the agent was asked to do.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID when the work is board-scoped.",
      },
      {
        name: "card_id",
        required: false,
        description: "Card UUID being worked — pass it whenever the run is card-scoped.",
      },
      {
        name: "session_id",
        required: false,
        description: "External coding-session ID for correlation.",
      },
      {
        name: "parent_execution_id",
        required: false,
        description: "Execution UUID this run is a retry of.",
      },
      {
        name: "role",
        required: false,
        description: "Pipeline role for this run, e.g. 'implementer', 'reviewer'.",
      },
      {
        name: "input_prompt",
        required: false,
        description: "Full rendered prompt sent to the LLM for this run.",
      },
    ],
    gotchas: [
      "Save the returned execution_id — log_execution_update and cancel_execution need it.",
      "Passing card_id flips the card to 'actively worked' presence on the board immediately — always bind it for card-scoped runs.",
    ],
    examplePrompt:
      "I'm starting an implementation run on card <card-id> in the <workspace> workspace. Log an execution start for runner <agent-id> with action 'tdd_implement', and keep the execution_id for the final update.",
    related: ["log_execution_update", "cancel_execution", "next_assignment", "get_agent_config"],
  },
  {
    name: "log_execution_update",
    category: "agents-executions",
    kind: "write",
    description:
      "Record progress or the outcome of a tracked execution — status, results, cost, errors. Call when a run completes, fails, or reaches a meaningful checkpoint.",
    params: [
      {
        name: "agent_id",
        required: true,
        description: "UUID of the runner that owns the execution.",
      },
      {
        name: "execution_id",
        required: true,
        description: "The id returned by log_execution_start.",
      },
      {
        name: "status",
        required: true,
        description: "New status — 'completed', 'failed', or 'running'.",
      },
      {
        name: "output_summary",
        required: false,
        description: "What the run accomplished or produced.",
      },
      {
        name: "tools_used",
        required: false,
        description: "MCP tool names invoked during the run.",
      },
      {
        name: "cards_affected",
        required: false,
        description: "Card UUIDs created, updated, or moved.",
      },
      {
        name: "error_message",
        required: false,
        description: "Error details when status is 'failed'.",
      },
      {
        name: "tool_calls_count",
        required: false,
        description: "Total number of tool calls made.",
      },
      {
        name: "tokens_used",
        required: false,
        description: "Total input + output tokens consumed.",
      },
      { name: "cost_usd", required: false, description: "Total cost in USD for this run." },
      {
        name: "input_prompt",
        required: false,
        description: "Full rendered prompt sent to the LLM for this run.",
      },
      {
        name: "duration_seconds",
        required: false,
        description: "Wall-clock duration of the run in seconds.",
      },
      {
        name: "ship_warnings",
        required: false,
        description: "Non-fatal issues captured during the stage, surfaced in the UI.",
      },
    ],
    gotchas: [
      "Partial update: only the fields you pass change — omitted fields keep their values.",
      "ship_warnings render as amber chips in the UI without flipping status to failed — use them for non-fatal issues.",
      "A late 'failed' write to an already-completed execution keeps status completed (the other fields still apply); failed → completed stays allowed — the runner's close is authoritative.",
    ],
    examplePrompt:
      "The run finished. Update execution <execution-id> for runner <agent-id> to 'completed' with a one-line output summary, the cards affected, and the token and cost totals.",
    related: ["log_execution_start", "cancel_execution", "list_executions"],
  },
  {
    name: "list_executions",
    category: "agents-executions",
    kind: "read",
    description:
      "List runner execution history for a workspace, newest first. Use to monitor runs, audit cost and loops, read a card's full pipeline history, or find zombie rows.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Workspace slug to read executions from.",
      },
      {
        name: "agent_id",
        required: false,
        description: "Only that runner's executions.",
      },
      {
        name: "status",
        required: false,
        description:
          "Filter: started, running, completed, failed, aborted, skipped — or virtual 'inflight'.",
      },
      {
        name: "role",
        required: false,
        description: "Filter by pipeline role, e.g. 'implementer', 'reviewer'.",
      },
      {
        name: "card_id",
        required: false,
        description: "Return that card's pipeline history instead of the workspace page.",
      },
      {
        name: "limit",
        required: false,
        description: "Max rows (default 20, backend caps at 200).",
      },
    ],
    gotchas: [
      "Rows are heavy — each carries the full input_prompt and tool invocations. Keep limit small unless you need deep history.",
      "status='inflight' is virtual: every started/running row not yet completed, unbounded by limit — the zombie-hunting filter to pair with cancel_execution.",
      "card_id switches to server-side card scope: the card's history ignoring limit — but capped at the newest 200 rows, so a runaway loop card can still truncate. status/role/agent_id filter within that window.",
    ],
    examplePrompt:
      "Show me the last 10 executions in the <workspace> workspace with list_executions and flag anything that looks like a retry loop. Then pull the full pipeline history for card <card-id>.",
    related: ["cancel_execution", "log_execution_start", "log_execution_update", "get_board_health"],
  },
  {
    name: "cancel_execution",
    category: "agents-executions",
    kind: "write",
    description:
      "Force a stuck 'running' execution to a terminal status, clearing the runner busy-guard. Use when a crashed run wedges the pipeline with 409 agent_busy errors.",
    params: [
      {
        name: "agent_id",
        required: true,
        description: "UUID of the runner that owns the stuck execution.",
      },
      {
        name: "execution_id",
        required: true,
        description: "Execution UUID to force terminal.",
      },
      {
        name: "status",
        required: false,
        description: "Terminal status to set — 'aborted' (default), 'completed', or 'failed'.",
      },
      {
        name: "reason",
        required: false,
        description: "Note recorded as the execution's output_summary.",
      },
    ],
    gotchas: [
      "Non-terminal statuses are rejected — they would not clear the busy-guard.",
      "Verify the row is a real zombie first (list_executions status='inflight'); cancelling a live run lets the runner reserve new work while the old run keeps going.",
      "A typo'd execution_id may not 404: when the runner has exactly one in-flight execution, the backend applies the write to that row instead — double-check the id before cancelling.",
    ],
    examplePrompt:
      "The runner is stuck returning agent_busy in the <workspace> workspace. Find inflight executions with list_executions, then cancel the zombie one with cancel_execution (reason 'wedged after crash') so the pipeline can resume.",
    related: ["list_executions", "get_board_health", "log_execution_update"],
  },
  {
    name: "get_workspace_metrics",
    category: "agents-executions",
    kind: "read",
    description:
      "Read workspace-wide velocity, quality and runner/card spend in one call; view narrows it to velocity or cost. Use for standup delivery and cost lines.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Workspace slug to read metrics from.",
      },
      {
        name: "view",
        required: false,
        description:
          "'all' (default) returns velocity, quality and cost; 'velocity' returns velocity + quality only; 'cost' returns spend only.",
      },
    ],
    gotchas: [
      "Workspace-wide only — use get_board_health for one board's velocity and get_agent_budget_status for one runner's spend.",
      "Falling velocity with a rising reversion_rate means rework, not slowdown; report the pair together.",
      "reversion_rate and agent_efficiency_score are null until there is enough history to compute them.",
      "cost.agents holds per-runner token and execution counts over 7d/30d; dollar amounts live on cost.cards (total_cost_usd) and depend on model_pricing in workspace config — without it costs read as 0.",
      "A card whose execution_count keeps climbing while it stays out of the done column is the money-loop signature — cross-check with list_executions.",
      "Report the totals as returned rather than re-deriving them; an unknown view is rejected before any request is made.",
    ],
    examplePrompt:
      "Write today's standup for the <workspace> workspace: call get_workspace_metrics, say whether throughput moved or just churned, and flag any card with more than 5 executions.",
    related: ["get_board_health", "get_agent_budget_status", "list_executions", "get_workspace_config"],
  },

  // ── activity ───────────────────────────────────────────────────────
  {
    name: "list_activity",
    category: "activity",
    kind: "read",
    description:
      "Query the audit trail of who changed what in a workspace or board, newest first. Use to review recent changes with entity-type, action, or free-text filters.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Workspace slug to read activity from.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to scope to one board; omit for workspace-wide.",
      },
      {
        name: "limit",
        required: false,
        description: "Max entries (default 50, backend caps at 100).",
      },
      {
        name: "entity_type",
        required: false,
        description:
          "Filter: board, column, card, note, resource, definition, channel, git_repo, workspace, member, agent.",
      },
      {
        name: "action",
        required: false,
        description:
          "Filter: created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed, dependencies_replaced.",
      },
      {
        name: "search",
        required: false,
        description: "Free-text search across activity summaries.",
      },
    ],
    gotchas: [
      "Tracks entity mutations (cards, notes, members...), not runner runs — for execution history use list_executions.",
      "The response carries agent_id attribution, but this MCP tool does not expose the backend's agent_id filter. entity_type='agent' returns runner lifecycle audit rows; it does not return every action performed by one runner.",
    ],
    examplePrompt:
      "Using list_activity, show the last 20 card changes on board <board-id> in the <workspace> workspace and summarize who did what today.",
    related: ["list_executions", "get_project_context", "get_board_health"],
  },

  // ── server-info ────────────────────────────────────────────────────
  {
    name: "whoami",
    category: "server-info",
    kind: "read",
    description:
      "Identify the caller of this MCP session — your authenticated user id, email, and name. Use it to learn your own user_id or confirm which account you act as.",
    params: [],
    gotchas: [
      "This is the USER behind the session — get_agent_config answers the different question of which runner is configured.",
    ],
    examplePrompt:
      "Using the Backplane MCP, call whoami and tell me which account this session is acting as.",
    related: ["get_agent_config", "get_server_info", "enable_toolsets", "list_workspace_members"],
  },
  {
    name: "get_server_info",
    category: "server-info",
    kind: "read",
    description:
      "Report the MCP server's version, full tool surface, this session's allowlist, and backend reachability. Run at session start to rule out tool or version drift.",
    params: [],
    gotchas: [
      "enabled_tools is what THIS session can actually call — the registered surface intersected with the allowlist (allowlist null = unrestricted).",
      "allowlist_unknown lists allowlisted names the server doesn't register — a sign of version drift between runner config and deployed server.",
      "Backend health is best-effort: an unreachable API sets backend.reachable=false instead of failing the call.",
    ],
    examplePrompt:
      "Start by calling get_server_info — confirm the server version, list which tools are enabled in this session, and check the backend is reachable before we do anything else.",
    related: ["get_agent_config", "whoami", "enable_toolsets", "get_project_context"],
  },
  {
    name: "enable_toolsets",
    category: "server-info",
    kind: "write",
    description:
      "Widen THIS session's server tool hand and request client refresh; notification delivery does not prove the client catalog updated.",
    params: [
      {
        name: "toolset_ids",
        required: true,
        description:
          "Toolset ids to add: all, default, or any group or category id listed under get_server_info.toolsets.available.",
      },
    ],
    gotchas: [
      "Widen-only and idempotent: a repeated call adds nothing and sends no notification. The change is per-process and never persisted — the next session starts from VALARIS_MCP_TOOLSETS again.",
      "The runner allowlist (VALARIS_MCP_ALLOWLIST) is a ceiling this tool never lifts, so under a runner launch it is a no-op.",
      "client_catalog_status is unverified: list_changed_sent and get_server_info confirm server state only. If tools remain missing, apply restart_env to the MCP server startup configuration, restart the server/connection and start a new agent session. Remote HTTP requires the server operator; preserve VALARIS_MCP_ALLOWLIST.",
    ],
    examplePrompt:
      "Call enable_toolsets with [\"autonomous-operations\"] so this session can manage runners, confirm the requested native tools are available to this client; if absent, follow restart_env recovery.",
    related: ["get_server_info", "whoami"],
  },
];
