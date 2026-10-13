// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ContentChannel, SessionContent } from "@/types/agent-session";

export type TranscriptEntry = { type: "message"; item: SessionContent } | { type: "call"; callId: string; parts: SessionContent[] };

// What a tool call is made of; a prompt or reply naming a call stays a message.
const CALL_PARTS: ReadonlySet<ContentChannel> = new Set(["tool_input", "tool_output", "command_output", "diff", "file_content", "error"]);

/**
 * The server's source order, with each call's parts gathered where the call
 * first appears: parallel calls interleave their input and output.
 */
export function transcriptEntries(items: readonly SessionContent[], { includeRaw }: { includeRaw: boolean }): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const calls = new Map<string, SessionContent[]>();
  for (const item of items) {
    if (item.channel === "native_record" && !includeRaw) continue;
    if (item.call_id && CALL_PARTS.has(item.channel)) {
      const parts = calls.get(item.call_id);
      if (parts) {
        parts.push(item);
        continue;
      }
      const started = [item];
      calls.set(item.call_id, started);
      entries.push({ type: "call", callId: item.call_id, parts: started });
      continue;
    }
    entries.push({ type: "message", item });
  }
  return entries;
}

// RFC 5987 `filename*=UTF-8''…`, the only form the server sends.
const ENCODED_FILENAME = /filename\*=UTF-8''([^;]+)/i;
// Control characters, bidi overrides (which can make "x\u202Efdp.exe" read as
// a PDF) and characters file systems refuse.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"|?*]/g;

/** The server's file name, reduced to a bare name a download can't misuse. */
export function downloadName(disposition: string | undefined, fallback: string): string {
  const encoded = disposition?.match(ENCODED_FILENAME)?.[1];
  if (!encoded) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded.trim());
  } catch {
    return fallback;
  }
  const name = (decoded.split(/[\\/]/).pop() ?? "").replace(UNSAFE_NAME_CHARACTERS, "").replace(/^\.+/, "").trim();
  return name || fallback;
}
