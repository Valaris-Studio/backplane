// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from "@/i18n/config";
import { formatNumber } from "@/lib/format";
import type { AgentSessionEvent } from "@/types/agent-session";
import { formatWallTime } from "./format";

// Mirrors backend/app/services/session_call_content.py: where a stored event
// keeps a call's output and error. Placeholders for withheld output
// ({bytes, sha256} or "[omitted N bytes sha256:…]") are never shown as output.
const OUTPUT_PATHS = [
  "output",
  "gen_ai.output",
  "gen_ai.tool.call.result",
  "command.output",
  "command.stdout",
  "command.stderr",
  "tool.output",
  "tool.result",
  "tool.response",
  "tool.stdout",
  "tool.stderr",
  "mcp.result",
  "mcp.response",
];
const COMPANION_DIGEST = /^\[omitted \d+ bytes sha256:[0-9a-f]+\]$/;

export const OUTPUT_DISPLAY_LIMIT = 16 * 1024;

function valueAt(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    return (node as Record<string, unknown>)[key];
  }, data);
}

function isPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return COMPANION_DIGEST.test(value);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 2 && keys.includes("bytes") && keys.includes("sha256");
  }
  return false;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function callOutput(events: AgentSessionEvent[]): string | null {
  for (const event of [...events].reverse()) {
    for (const path of OUTPUT_PATHS) {
      const value = valueAt(event.data, path);
      if (value === undefined || value === null || value === "" || isPlaceholder(value)) continue;
      return asText(value);
    }
  }
  return null;
}

export function callError(events: AgentSessionEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const error = valueAt(event.data, "error");
    if (typeof error === "string" && error) return error;
    const message = valueAt(event.data, "error.message");
    if (typeof message === "string" && message) return message;
  }
  return null;
}

export function formatCallDuration(durationMs: number): string {
  if (durationMs < 60_000) {
    return i18n.t("sessions.duration.seconds", {
      s: formatNumber(durationMs / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
    });
  }
  return formatWallTime(durationMs / 1000);
}
