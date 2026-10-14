// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect } from "react";

import { commands, type AgentEntry } from "../ipc/bindings";
import { useStoreSelector } from "./external-store";
import { createRefetchable } from "./refetchable";

const NO_AGENTS: readonly AgentEntry[] = [];

function parseAgents(raw: unknown): readonly AgentEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const wellFormed = raw.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string");
  return wellFormed ? (raw as AgentEntry[]) : null;
}

export const agentsResource = createRefetchable(() => commands.agents(), parseAgents);

/** The SSE `agents` event carries the whole `GET /v1/agents` list. */
export function applyAgentsEvent(data: unknown): void {
  const agents = parseAgents(data);
  if (agents) agentsResource.push(agents);
}

/**
 * After a daemon outage the missed events are gone; fetch what is true now,
 * even if a fetch was running (its answer may predate the outage).
 */
export function refreshAgentsAfterReconnect(): void {
  agentsResource.refetchIfUsed();
}

/** The daemon went away, or another installation took over: nothing held is known to be true. */
export function forgetAgents(): void {
  agentsResource.forget();
}

function useAgentsLoaded(): void {
  useEffect(() => agentsResource.ensure(), []);
}

export function useAgents(): readonly AgentEntry[] {
  useAgentsLoaded();
  return useStoreSelector(agentsResource.store, (agents) => agents ?? NO_AGENTS);
}

export function useAgent(id: string): AgentEntry | null {
  useAgentsLoaded();
  return useStoreSelector(agentsResource.store, (agents) => agents?.find((agent) => agent.id === id) ?? null);
}

export function resetAgentsForTests(): void {
  agentsResource.reset();
}
