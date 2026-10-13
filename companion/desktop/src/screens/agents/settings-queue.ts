// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type AgentId } from "../../ipc/bindings";
import { callDaemon, type DaemonResult } from "../../ipc/daemon";
import { agentsResource } from "../../stores/agents";
import { statusStore } from "../../stores/daemon-stream";
import { isAgentEnabled, nextEnabledAgents } from "./agent-model";

/**
 * `enabled_agents` is one list shared by every row, so writes run one at a
 * time and each builds on the newest value known when it starts. Never the
 * value a row rendered with, which two quick toggles would both read and so
 * undo one another.
 *
 * The list the daemon last returned stays authoritative until a status
 * reports that same list: after a failed policy refresh the daemon keeps
 * emitting statuses with the old one. A reconnect or another installation
 * starts over from status.
 */
interface SavedList {
  enabledAgents: readonly string[];
  installationId: string;
  caughtUp: boolean;
}

let lastSaved: SavedList | null = null;
let queueTail: Promise<unknown> = Promise.resolve();

function sameIds(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && b.every((id) => a.includes(id));
}

statusStore.subscribe(() => {
  const status = statusStore.get();
  if (!lastSaved) return;
  if (status === null || status.installation_id !== lastSaved.installationId) lastSaved = null;
  else if (sameIds(status.capture.enabled_agents, lastSaved.enabledAgents)) lastSaved = { ...lastSaved, caughtUp: true };
});

/** The list capture is really running with, as far as this app knows. */
export function knownEnabledAgents(): readonly string[] | null {
  const status = statusStore.get();
  if (lastSaved && !lastSaved.caughtUp) return lastSaved.enabledAgents;
  return status?.capture.enabled_agents ?? null;
}

function reportedAgentIds(): string[] {
  const fromStatus = statusStore.get()?.agents.map((agent) => agent.id) ?? [];
  const fromAgents = agentsResource.store.get()?.map((entry) => entry.id) ?? [];
  return [...new Set([...fromStatus, ...fromAgents])];
}

function savedList(settings: unknown, fallback: string[]): string[] {
  const returned = (settings as { enabled_agents?: unknown } | null)?.enabled_agents;
  return Array.isArray(returned) && returned.every((id) => typeof id === "string") ? returned : fallback;
}

/** Resolves to whether a write was needed; a no-op when the agent is already in the wanted state. */
export function setAgentEnabled(id: AgentId, enable: boolean): Promise<DaemonResult<boolean>> {
  const write = async (): Promise<DaemonResult<boolean>> => {
    const current = knownEnabledAgents();
    if (isAgentEnabled(id, current) === enable) return { ok: true, value: false };
    const next = nextEnabledAgents(current, id, enable, reportedAgentIds());
    // Unknown ids come from the daemon itself, so they are its own AgentIds.
    const result = await callDaemon(() => commands.updateSettings({ enabled_agents: next as AgentId[] }));
    if (!result.ok) return result;
    const status = statusStore.get();
    const enabledAgents = savedList(result.value, next);
    lastSaved = status ? { enabledAgents, installationId: status.installation_id, caughtUp: sameIds(status.capture.enabled_agents, enabledAgents) } : null;
    return { ok: true, value: true };
  };
  const queued = queueTail.then(write, write);
  queueTail = queued;
  return queued;
}

export function resetSettingsQueueForTests(): void {
  lastSaved = null;
  queueTail = Promise.resolve();
}
