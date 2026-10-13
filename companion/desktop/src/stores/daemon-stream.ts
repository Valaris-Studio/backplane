// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Channel } from "@tauri-apps/api/core";

import { commands, type AttentionItem, type CompanionStatus, type DaemonStreamMessage } from "../ipc/bindings";
import { toCompanionError } from "../ipc/errors";
import { applyAgentAccessEvent, forgetAgentAccess, refreshAgentAccessAfterReconnect, resetAgentAccessForTests } from "./agent-access";
import { applyAgentsEvent, forgetAgents, refreshAgentsAfterReconnect, resetAgentsForTests } from "./agents";
import { createExternalStore } from "./external-store";
import { resetServiceStartForTests } from "./companion-service";
import { applyPairingEvent, resetPairingForTests } from "./pairing";
import { applyProjectsEvent, forgetProjects, refreshAfterPolicyChange, refreshProjectsAfterReconnect, resetProjectsForTests } from "./projects";
import { applySessionEvent, clearLiveSessions, resetSessionsForTests } from "./sessions";

export type DaemonConnection =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "unreachable"; reason: string };

const CONNECTING: DaemonConnection = { state: "connecting" };
const CONNECTED: DaemonConnection = { state: "connected" };
const NO_ATTENTION: AttentionItem[] = [];
const DEFAULT_INITIAL_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 10_000;

export const connectionStore = createExternalStore<DaemonConnection>(CONNECTING);
export const statusStore = createExternalStore<CompanionStatus | null>(null);
export const attentionStore = createExternalStore<AttentionItem[]>(NO_ATTENTION);

export interface DaemonStreamOptions {
  initialRetryMs?: number;
  maxRetryMs?: number;
}

// Which installation the cached per-account data belongs to. A re-pair makes
// a new installation (and a new server means a new endpoint), so this changes
// with the account; the account object itself arrives late and may flap to
// null, so it is not part of the key.
let accountIdentity: string | null = null;

function followAccount(status: CompanionStatus): void {
  const identity = [status.installation_id, status.endpoint, String(status.connected)].join("\n");
  if (accountIdentity !== null && identity !== accountIdentity) {
    forgetAgents();
    forgetProjects();
    forgetAgentAccess();
    refreshAgentsAfterReconnect();
    refreshProjectsAfterReconnect();
    refreshAgentAccessAfterReconnect();
  }
  accountIdentity = identity;
}

export function applyStreamMessage(message: DaemonStreamMessage): void {
  switch (message.type) {
    case "daemon.connected":
      connectionStore.set(CONNECTED);
      refreshAgentsAfterReconnect();
      refreshProjectsAfterReconnect();
      refreshAgentAccessAfterReconnect();
      break;
    case "daemon.unreachable":
      connectionStore.set({ state: "unreachable", reason: message.data.reason });
      statusStore.set(null);
      clearLiveSessions();
      forgetAgents();
      forgetProjects();
      forgetAgentAccess();
      break;
    case "status":
      // Before the status lands, so no subscriber sees the new origin with the old account's data.
      followAccount(message.data);
      statusStore.set(message.data);
      break;
    case "attention":
      attentionStore.set(message.data.items);
      break;
    case "session":
      applySessionEvent(message.data);
      break;
    case "agents":
      applyAgentsEvent(message.data);
      break;
    case "projects":
      applyProjectsEvent(message.data);
      break;
    case "policy.changed":
      refreshAfterPolicyChange();
      break;
    case "pairing":
      applyPairingEvent(message.data);
      break;
    case "agent_access":
      applyAgentAccessEvent(message.data);
      break;
    default:
      break;
  }
}

let stopActiveStream: (() => void) | null = null;

/**
 * Attaches the webview to the shell's daemon stream once per page. Rust owns
 * the socket reconnects; this only retries the IPC subscription itself.
 */
export function startDaemonStream(options: DaemonStreamOptions = {}): () => void {
  if (stopActiveStream) return stopActiveStream;

  const initialRetryMs = options.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  let stopped = false;
  let failedAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let channel: Channel<DaemonStreamMessage> | undefined;

  const subscribe = () => {
    channel = new Channel<DaemonStreamMessage>(applyStreamMessage);
    commands.subscribeEvents(channel).then(
      () => {
        failedAttempts = 0;
      },
      (rejection: unknown) => {
        if (stopped) return;
        const error = toCompanionError(rejection);
        connectionStore.set({ state: "unreachable", reason: error.kind === "unreachable" ? error.reason : error.kind });
        const delay = Math.min(initialRetryMs * 2 ** failedAttempts, maxRetryMs);
        failedAttempts += 1;
        retryTimer = setTimeout(subscribe, delay);
      },
    );
  };
  subscribe();

  const stop = () => {
    stopped = true;
    clearTimeout(retryTimer);
    if (channel) channel.onmessage = () => {};
    if (stopActiveStream === stop) stopActiveStream = null;
  };
  stopActiveStream = stop;
  return stop;
}

export function resetDaemonStreamForTests(): void {
  stopActiveStream?.();
  connectionStore.set(CONNECTING);
  statusStore.set(null);
  attentionStore.set(NO_ATTENTION);
  resetSessionsForTests();
  resetAgentsForTests();
  resetAgentAccessForTests();
  resetProjectsForTests();
  resetPairingForTests();
  resetServiceStartForTests();
  accountIdentity = null;
}
