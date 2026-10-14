// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { AgentStatus } from "../ipc/bindings";
import { connectionStore, statusStore } from "./daemon-stream";
import { useStoreSelector } from "./external-store";

const NO_AGENTS: AgentStatus[] = [];

export function useConnectionState() {
  return useStoreSelector(connectionStore, (connection) => connection.state);
}

/** null until the first status arrives. */
export function useDeviceConnected(): boolean | null {
  return useStoreSelector(statusStore, (status) => status?.connected ?? null);
}

export function useCaptureState(): string | null {
  return useStoreSelector(statusStore, (status) => status?.capture.state ?? null);
}

export function useAgentStatuses(): AgentStatus[] {
  return useStoreSelector(statusStore, (status) => status?.agents ?? NO_AGENTS);
}

export function useQueuedRecords(): number | null {
  return useStoreSelector(statusStore, (status) => status?.queue.records ?? null);
}
