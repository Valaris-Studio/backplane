// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

/**
 * Keyed by the daemon's agent ids (`GET /v1/agents`, status, attention) and by the extra
 * harness ids its sessions carry: Codex Desktop's sessions are `codex_desktop`.
 */
const KNOWN_AGENTS: Record<string, { name: string; monogram: string }> = {
  claude_code: { name: "Claude Code", monogram: "CC" },
  codex_cli: { name: "Codex", monogram: "Cx" },
  codex_desktop: { name: "Codex app", monogram: "Cx" },
  pi_cli: { name: "Pi", monogram: "Pi" },
};

// Codex CLI and the Codex app share one integration (the same hooks.json), so one agent row.
const INTEGRATION_OF_HARNESS: Record<string, string> = { codex_desktop: "codex_cli" };

export function isKnownAgent(id: string): boolean {
  return Object.hasOwn(KNOWN_AGENTS, id);
}

export function agentDisplayName(id: string): string {
  return KNOWN_AGENTS[id]?.name ?? id;
}

export function agentMonogram(id: string): string {
  const known = KNOWN_AGENTS[id];
  if (known) return known.monogram;
  return id.slice(0, 1).toUpperCase() + id.slice(1, 2);
}

/** The agent integration a session's harness belongs to. */
export function agentIntegrationId(harness: string): string {
  return INTEGRATION_OF_HARNESS[harness] ?? harness;
}
