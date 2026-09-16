// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export function summarizePayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  if (keys.length === 0) return "";
  const preferred = ["title", "name", "summary", "status", "id"];
  for (const key of preferred) {
    if (key in payload) {
      const v = payload[key];
      if (typeof v === "string" || typeof v === "number") return `${key}: ${v}`;
    }
  }
  return keys.slice(0, 3).join(", ");
}
