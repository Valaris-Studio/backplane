// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The English-only text handed to the user's coding agent. It is deliberately
// NOT translated: the reader is an MCP-capable agent, not the user. Only the UI
// chrome around it follows the locale.
//
// DELIBERATE EXCEPTION to the rule pinned by LaunchRunnerWizard.keyleak.test —
// raw keys are never interpolated into copyable SHELL COMMANDS, because those
// land in terminal scrollback and shell history. This is not a shell command;
// it is a handoff message the user pastes into an agent session, and putting
// the real key in it removes the single most error-prone manual step in
// activation. The key reaches the agent either way — the choice is only whether
// the user has to transcribe it. Keep the runner's launch command key-free.

export const KEY_PLACEHOLDER = "<your API key vlr_…>";

export const PYPI_URL = "https://pypi.org/project/backplane-mcp/";
export const GITHUB_URL = "https://github.com/Valaris-Studio/backplane";
export const GIT_INSTALL_COMMAND =
  'uvx --from "git+https://github.com/Valaris-Studio/backplane.git#subdirectory=mcp-server" backplane-mcp';

// Human loop preparation is distinct from actual runner execution, whose
// startup surface remains all, intersected with its stage allowlist.
export type HandoffIntent = "interactive" | "loops" | "runner" | "everything";
export type ConnectionPreset = Exclude<HandoffIntent, "runner">;

export const DEFAULT_HANDOFF_INTENT: ConnectionPreset = "interactive";

const TOOLSETS_BY_INTENT = {
  interactive: "default",
  loops: "default,autonomous-operations",
  runner: "all",
  everything: "all",
} as const satisfies Record<HandoffIntent, string>;

export function toolsetsForIntent(intent: HandoffIntent) {
  return TOOLSETS_BY_INTENT[intent];
}

interface HandoffInput {
  origin: string;
  apiKey: string | null;
  intent?: HandoffIntent;
}

const TOOLSETS_GUIDANCE: Record<HandoffIntent, string> = {
  interactive:
    "This loads the compact default interactive toolsets. Call get_server_info to see what the server has loaded. To add tools, call enable_toolsets with the desired toolset ids. Its tools/list_changed notification only updates clients that refresh their tool catalog; server-side success does not prove the client exposes the tools. If they remain missing, apply the returned restart_env to the MCP server config to preserve every loaded group (for example VALARIS_MCP_TOOLSETS=default,autonomous-operations), then restart the MCP server and start a new agent session. Changing the environment alone or starting a new session that reuses the old server process is insufficient. Alternatively, set VALARIS_MCP_TOOLSETS=all to load every tool from startup, subject to the client's catalog limits.",
  loops: "This loads the compact default tools plus autonomous operations so a person can prepare and manage loops with their coding agent. If native tools remain missing, apply the exact returned restart_env when available to preserve every loaded group, then restart the MCP server and start a new agent session. Server-enabled tools and tools/list_changed do not prove the client exposes them.",
  runner: "This loads every tool: a runner's stage allowlist is the only narrowing.",
  everything: "This loads every tool from startup for clients that do not refresh their tool catalog. The larger catalog may reach client limits; if needed, select specific groups with VALARIS_MCP_TOOLSETS, restart the MCP server and start a new agent session.",
};

// The closing whoami instruction is load-bearing: that first authenticated call
// is what the verify step listens for. Do not drop it when editing the prose.
export function composeAgentMessage({
  origin,
  apiKey,
  intent = DEFAULT_HANDOFF_INTENT,
}: HandoffInput): string {
  const key = apiKey ?? KEY_PLACEHOLDER;
  return [
    "Set up the Backplane MCP server for me.",
    "",
    "It's a Python package, so you can run it straight from PyPI with `uvx backplane-mcp`",
    "(package: backplane-mcp; source: github.com/Valaris-Studio/backplane, subdirectory mcp-server).",
    "",
    "This example is for a fresh local stdio connection: the locally launched process can call a remote Backplane API via VALARIS_API_URL.",
    "Preserve any existing custom toolsets and operator configuration; never remove an allowlist. Merge this example into existing configuration instead of replacing it.",
    "For an existing remote MCP HTTP connection, the operator configures and restarts the remote MCP server; local client environment variables cannot configure that service.",
    "",
    "Register it in my MCP client config as a server named \"valaris\", with these environment variables:",
    "",
    `  VALARIS_API_URL=${origin}`,
    `  VALARIS_API_KEY=${key}`,
    `  VALARIS_MCP_TOOLSETS=${toolsetsForIntent(intent)}`,
    "",
    TOOLSETS_GUIDANCE[intent],
    "",
    "Then verify the connection by calling the `whoami` tool, and tell me what it returns.",
  ].join("\n");
}

export function composeMcpServersJson({
  origin,
  apiKey,
  intent = DEFAULT_HANDOFF_INTENT,
}: HandoffInput): string {
  return JSON.stringify(
    {
      mcpServers: {
        valaris: {
          command: "uvx",
          args: ["backplane-mcp"],
          env: {
            VALARIS_API_URL: origin,
            VALARIS_API_KEY: apiKey ?? KEY_PLACEHOLDER,
            VALARIS_MCP_TOOLSETS: toolsetsForIntent(intent),
          },
        },
      },
    },
    null,
    2,
  );
}
