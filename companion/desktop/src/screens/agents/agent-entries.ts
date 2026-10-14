// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { AgentEntry, CompanionStatus } from "../../ipc/bindings";
import { agentsResource } from "../../stores/agents";
import { statusStore } from "../../stores/daemon-stream";

/**
 * Status and the `/v1/agents` list both carry each integration; whichever
 * reached the webview last is the truth. Every change of the agents store is
 * stamped with the status that was current when it arrived, from app start
 * (not from when the screen mounts), so an entry older than the status is
 * never shown over it.
 */
interface Arrival {
  entries: readonly AgentEntry[] | null;
  status: CompanionStatus | null;
}

const NO_ENTRIES: readonly AgentEntry[] = [];

let arrival: Arrival = { entries: agentsResource.store.get(), status: statusStore.get() };
// Set only while pushing an answer whose request began under an older status.
let statusAtRequest: CompanionStatus | null | undefined;

agentsResource.store.subscribe(() => {
  arrival = { entries: agentsResource.store.get(), status: statusAtRequest === undefined ? statusStore.get() : statusAtRequest };
});

export function agentEntriesNewerThan(status: CompanionStatus | null): readonly AgentEntry[] {
  const entries = agentsResource.store.get();
  return entries && arrival.entries === entries && arrival.status === status ? entries : NO_ENTRIES;
}

/** Pushes a fetched list, stamped with the status current when the request began: a status that landed mid-flight wins. */
export function pushAgentEntries(entries: readonly AgentEntry[], requestedUnder: CompanionStatus | null): void {
  statusAtRequest = requestedUnder;
  try {
    agentsResource.push(entries);
  } finally {
    statusAtRequest = undefined;
  }
}

function isAgentEntry(value: unknown): value is AgentEntry {
  if (typeof value !== "object" || value === null) return false;
  const { id, integration } = value as { id?: unknown; integration?: unknown };
  return typeof id === "string" && typeof integration === "object" && integration !== null;
}

/** Folds one install/uninstall answer into the list; the daemon's next `agents` event replaces it wholesale. */
export function pushAgentEntry(value: unknown, requestedUnder: CompanionStatus | null): void {
  if (!isAgentEntry(value)) return;
  const current = agentsResource.store.get() ?? NO_ENTRIES;
  const merged = current.some((entry) => entry.id === value.id) ? current.map((entry) => (entry.id === value.id ? value : entry)) : [...current, value];
  pushAgentEntries(merged, requestedUnder);
}
