// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sha256 } from "./sha256";

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function timelineSequence(value: string | null): string | null {
  return value !== null && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : null;
}

export function entryState(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function timelineNonce(state: unknown): string | null {
  const token = entryState(entryState(state).bpTimeline);
  return token.v === 1 && typeof token.n === "string" && NONCE.test(token.n) && Object.keys(token).length === 2 ? token.n : null;
}

export async function timelineRequestId(nonce: string, ownerId: string, slug: string, boardId: string): Promise<string> {
  // JSON's array framing is unambiguous even when an identity contains a separator.
  const input = new TextEncoder().encode(JSON.stringify(["bp.timeline.request.v1", nonce, ownerId, slug, boardId]));
  const bytes = sha256(input).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
