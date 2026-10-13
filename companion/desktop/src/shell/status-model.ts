// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { agentDisplayName } from "../components/agent-identity";
import type { IconName, TrayGlyphState } from "../components/Icon";
import type { AttentionItem, CompanionStatus } from "../ipc/bindings";
import { platformCopy } from "../platform/copy";

/** Agent states that need the user; the Rust tray uses the same set (tray_menu.rs). */
export const AGENT_PROBLEM_STATES: ReadonlySet<string> = new Set(["needs_trust", "broken", "invalid_config"]);

export type StatusTone = "success" | "warning" | "error" | "neutral";
export type PauseControl = "pause" | "resume" | "pause-disabled" | "none";

export interface StatusModel {
  tone: StatusTone;
  glyph: { kind: "tray"; state: TrayGlyphState } | { kind: "icon"; name: IconName };
  title: string;
  sub: string;
  pauseControl: PauseControl;
  /** Tooltip for a disabled pause control. */
  pauseHint?: string;
  showTabs: boolean;
  /** The menu-bar glyph for the same status, with the Rust tray's precedence. */
  trayState: TrayGlyphState;
}

export interface StatusModelInput {
  status: CompanionStatus;
  attention: readonly AttentionItem[];
  /** Live sessions from the session stream, when something counts them. */
  liveSessions?: number | null;
  deviceName?: string | null;
}

/** Agents in a problem state plus agents named by an attention item, in first-seen order. */
export function agentsNeedingAttention(status: CompanionStatus, attention: readonly AttentionItem[]): string[] {
  const ids = status.agents.filter((agent) => AGENT_PROBLEM_STATES.has(agent.state)).map((agent) => agent.id);
  for (const item of attention) {
    if (item.agent) ids.push(item.agent);
  }
  return [...new Set(ids)];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function withDevice(text: string, deviceName: string | null | undefined): string {
  return deviceName ? `${text} · ${deviceName}` : text;
}

function capturingSub(status: CompanionStatus, liveSessions: number | null | undefined, deviceName: string | null | undefined): string {
  if (typeof liveSessions === "number" && liveSessions > 0) {
    return withDevice(`${liveSessions} live ${plural(liveSessions, "session", "sessions")}`, deviceName);
  }
  // No counted session (none yet, or a daemon that sends no session events): the agents' own signal.
  const receiving = status.agents.filter((agent) => agent.receiving);
  const [only] = receiving;
  if (receiving.length === 1 && only) return withDevice(`Receiving from ${agentDisplayName(only.id)}`, deviceName);
  if (receiving.length > 1) return withDevice(`Receiving from ${receiving.length} agents`, deviceName);
  return withDevice("Waiting for a session", deviceName);
}

function localPauseControl(state: string): PauseControl {
  if (state === "paused_locally") return "resume";
  if (state === "paused_by_server") return "pause-disabled";
  return "pause";
}

/**
 * What the popover header says for a status. Precedence follows the tray
 * (disconnected > offline > paused > attention > capturing) so the header
 * and the menu-bar glyph never disagree.
 */
export function statusModel({ status, attention, liveSessions, deviceName }: StatusModelInput): StatusModel {
  const state = status.capture.state;

  if (status.revoked || state === "revoked") {
    return {
      tone: "error",
      glyph: { kind: "icon", name: "power" },
      title: "Disconnected",
      sub: `${platformCopy().ThisDevice} needs to connect again`,
      pauseControl: "none",
      showTabs: false,
      trayState: "disconnected",
    };
  }
  if (!status.connected || state === "not_connected") {
    return {
      tone: "neutral",
      glyph: { kind: "tray", state: "disconnected" },
      title: "Not connected",
      sub: `Connect ${platformCopy().thisDevice} to start capturing`,
      pauseControl: "none",
      showTabs: false,
      trayState: "disconnected",
    };
  }
  if (state === "policy_stale" || status.queue.backing_off) {
    return {
      tone: "warning",
      glyph: { kind: "icon", name: "cloud-off" },
      title: "Can’t reach Backplane",
      sub: `Sessions are saved on ${platformCopy().thisDevice} for now`,
      pauseControl: localPauseControl(state),
      showTabs: true,
      trayState: "offline",
    };
  }
  if (state === "paused_locally") {
    return {
      tone: "neutral",
      glyph: { kind: "icon", name: "pause" },
      title: "Paused",
      sub: "Nothing is recorded until you resume",
      pauseControl: "resume",
      showTabs: true,
      trayState: "paused",
    };
  }
  if (state === "paused_by_server") {
    return {
      tone: "neutral",
      glyph: { kind: "icon", name: "pause" },
      title: "Paused from Backplane",
      sub: "Resume it from this device’s page in Backplane",
      pauseControl: "pause-disabled",
      pauseHint: "Paused from Backplane",
      showTabs: true,
      trayState: "paused",
    };
  }
  if (state !== "active") {
    return {
      tone: "neutral",
      glyph: { kind: "tray", state: "capturing" },
      title: "Companion",
      sub: `Status: ${state.replace(/_/g, " ")}`,
      pauseControl: "none",
      showTabs: true,
      trayState: "capturing",
    };
  }

  const needingAttention = agentsNeedingAttention(status, attention);
  if (needingAttention.length > 0 || attention.length > 0) {
    const sub =
      needingAttention.length === 0
        ? "Something needs your attention"
        : needingAttention.length === 1
          ? "One agent needs your attention"
          : `${needingAttention.length} agents need your attention`;
    return {
      tone: "warning",
      glyph: { kind: "icon", name: "alert" },
      title: "Capturing",
      sub,
      pauseControl: "pause",
      showTabs: true,
      trayState: "attention",
    };
  }

  return {
    tone: "success",
    glyph: { kind: "tray", state: "capturing" },
    title: "Capturing",
    sub: capturingSub(status, liveSessions, deviceName),
    pauseControl: "pause",
    showTabs: true,
    trayState: "capturing",
  };
}
