// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type AgentId, type DiscoveredProject, type SavedDiagnostics } from "./bindings";
import { callDaemon, type DaemonResult } from "./daemon";

/** "Add a folder…": the found project the daemon recorded for the picked folder; `null` when the user cancels. */
export function pickProjectFolder(): Promise<DaemonResult<DiscoveredProject | null>> {
  return callDaemon(() => commands.pickProjectFolder());
}

/** Rust looks the path up from the daemon; the webview only names the agent. */
export function revealAgentConfig(agentId: AgentId): Promise<DaemonResult<null>> {
  return callDaemon(() => commands.revealAgentConfig(agentId));
}

export function saveDiagnostics(): Promise<DaemonResult<SavedDiagnostics>> {
  return callDaemon(() => commands.saveDiagnostics());
}

export function launchAtLogin(): Promise<DaemonResult<boolean>> {
  return callDaemon(() => commands.launchAtLoginGet());
}

/** Resolves to the state the OS reports after the change. */
export function setLaunchAtLogin(enabled: boolean): Promise<DaemonResult<boolean>> {
  return callDaemon(() => commands.launchAtLoginSet(enabled));
}

export function notificationsEnabled(): Promise<DaemonResult<boolean>> {
  return callDaemon(() => commands.notificationsGet());
}

export function setNotificationsEnabled(enabled: boolean): Promise<DaemonResult<boolean>> {
  return callDaemon(() => commands.notificationsSet(enabled));
}

/** Fire and forget: a failed hide leaves the popover open, nothing to report. */
export async function hidePopover(): Promise<void> {
  await callDaemon(() => commands.hidePopover());
}

export type { AgentId, SavedDiagnostics };
