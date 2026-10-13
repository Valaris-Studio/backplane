// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { agentMonogram, isKnownAgent } from "./agent-identity";

/** The agent's monogram in its brand colour; decorative, so pair it with the agent's name in text. */
export function AgentTile({ agent, size = "md" }: { agent: string; size?: "md" | "sm" }) {
  return (
    <span className="bp-agent-tile" data-agent={isKnownAgent(agent) ? agent : "unknown"} data-size={size} aria-hidden="true">
      {agentMonogram(agent)}
    </span>
  );
}
