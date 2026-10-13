// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect } from "react";

import { commands, type AgentAccess } from "../ipc/bindings";
import { callDaemon, type DaemonResult } from "../ipc/daemon";
import { createExternalStore, useStoreSelector } from "./external-store";
import { createRefetchable } from "./refetchable";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseAgentAccess(raw: unknown): AgentAccess | null {
  if (!isRecord(raw) || !isRecord(raw.key) || !isRecord(raw.prerequisites)) return null;
  const { mappings, warnings } = raw;
  if (!Array.isArray(mappings) || !Array.isArray(warnings)) return null;
  const mappingsWellFormed = mappings.every(
    (mapping) => isRecord(mapping) && typeof mapping.mapping_id === "string" && typeof mapping.enabled === "boolean" && Array.isArray(mapping.agents),
  );
  const warningsWellFormed = warnings.every((warning) => isRecord(warning) && typeof warning.entry_name === "string");
  return mappingsWellFormed && warningsWellFormed ? (raw as AgentAccess) : null;
}

export const agentAccessResource = createRefetchable(() => commands.agentAccessGet(), parseAgentAccess);

type Requested = Readonly<Record<string, boolean>>;

const NOTHING_REQUESTED: Requested = {};

/** A switch flipped by the owner shows at once, until the daemon's answer (or failure) settles it. */
const requestedStore = createExternalStore<Requested>(NOTHING_REQUESTED);

function settleRequest(mappingId: string): void {
  const rest = Object.fromEntries(Object.entries(requestedStore.get()).filter(([id]) => id !== mappingId));
  requestedStore.set(Object.keys(rest).length === 0 ? NOTHING_REQUESTED : rest);
}

/** The SSE `agent_access` event carries the whole `GET /v1/agent-access` document. */
export function applyAgentAccessEvent(data: unknown): void {
  const access = parseAgentAccess(data);
  if (access) agentAccessResource.push(access);
}

export function refreshAgentAccessAfterReconnect(): void {
  agentAccessResource.refetchIfUsed();
}

export function forgetAgentAccess(): void {
  agentAccessResource.forget();
}

// Per mapping, bumped by every toggle: an answer to an older toggle may land
// after a newer one's and is dropped, as refetchable's `generation` does.
const latestRequest = new Map<string, number>();

/** null when a newer toggle of the same mapping replaced this one: its answer, or failure, no longer matters. */
export async function setAgentAccess(mappingId: string, enabled: boolean): Promise<DaemonResult<AgentAccess> | null> {
  const request = (latestRequest.get(mappingId) ?? 0) + 1;
  latestRequest.set(mappingId, request);
  requestedStore.set({ ...requestedStore.get(), [mappingId]: enabled });
  const result = await callDaemon(() => commands.agentAccessSet(mappingId, enabled));
  if (latestRequest.get(mappingId) !== request) return null;
  if (result.ok) agentAccessResource.push(result.value);
  settleRequest(mappingId);
  return result;
}

/** null until the daemon has answered; a daemon without agent access never does. */
export function useAgentAccess(): AgentAccess | null {
  useEffect(() => agentAccessResource.ensure(), []);
  return useStoreSelector(agentAccessResource.store, (access) => access);
}

/** What the owner just asked for this mapping, while the daemon hasn't answered. */
export function useAgentAccessRequested(mappingId: string): boolean | undefined {
  return useStoreSelector(requestedStore, (requested) => requested[mappingId]);
}

export function resetAgentAccessForTests(): void {
  agentAccessResource.reset();
  requestedStore.set(NOTHING_REQUESTED);
  latestRequest.clear();
}
