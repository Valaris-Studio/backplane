// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { agentDisplayName, isKnownAgent } from "../../components/agent-identity";

// The daemon's harness ids. DK-4c rekeys the kit's identity table to these; until then
// agentDisplayName echoes them back, which is still a known agent, not a raw daemon string.
const DAEMON_AGENT_IDS: ReadonlySet<string> = new Set(["claude_code", "codex_cli", "codex_desktop", "pi_cli"]);

function isRecognizedAgent(id: string): boolean {
  return DAEMON_AGENT_IDS.has(id) || isKnownAgent(id);
}

/** An agent's name, or "Unknown agent": a harness id this build doesn't know is never shown raw. */
export function agentLabel(id: string): string {
  return isRecognizedAgent(id) ? agentDisplayName(id) : "Unknown agent";
}

/** What AgentTile gets: the id itself, or a placeholder that renders a neutral "?" tile. */
export function agentTileId(id: string): string {
  return isRecognizedAgent(id) ? id : "?";
}
