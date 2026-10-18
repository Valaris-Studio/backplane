// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WebSocketEvent } from "@/lib/websocket";

/** Serialized UTF-8 size of one retained frame, envelope included. */
export const OBSERVER_FRAME_MAX_BYTES = 16 * 1024;

export const REDACTED_VALUE = "[redacted]";
export const TRUNCATED_VALUE = "[truncated]";

/** What the Observer keeps and renders instead of the delivered frame. */
export interface ObserverFrame extends WebSocketEvent {
  projection: { redacted: boolean; truncated: boolean };
}

interface ProjectionLimits {
  maxStringChars: number;
  maxNodes: number;
}

// Tried in order until the frame fits OBSERVER_FRAME_MAX_BYTES; a frame that
// fits none keeps only its envelope.
const PROJECTION_ATTEMPTS: ProjectionLimits[] = [
  { maxStringChars: 2048, maxNodes: 400 },
  { maxStringChars: 256, maxNodes: 100 },
  { maxStringChars: 64, maxNodes: 40 },
];
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_ENVELOPE_CHARS = 256;
// Text past a cut is still scanned this far, and that margin is never shown,
// so a credential straddling the cut is not displayed half-recognized.
const REDACTION_MARGIN_CHARS = 512;

const SENSITIVE_KEY_WORDS = new Set([
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "passphrase",
  "passwd",
  "password",
  "secret",
  "signature",
]);

type Replacement = string | ((match: string) => string);

const SECRET_TEXT_PATTERNS: Array<[RegExp, Replacement]> = [
  // "Authorization: Bearer abc", "authorization=Basic abc": the whole value.
  [
    /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+/gi,
    `$1${REDACTED_VALUE}`,
  ],
  // Cookie headers carry multiple semicolon-separated values on one line.
  [/\b(cookie[ \t]*:[ \t]*)[^\r\n]+/gi, `$1${REDACTED_VALUE}`],
  // A bare "Bearer <token>"; the length floor keeps prose like "bearer of" intact.
  [/\b(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1${REDACTED_VALUE}`],
  // JWTs, including one cut off before its later segments.
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)*/g, REDACTED_VALUE],
  // Companion device tokens have exactly 43 URL-safe suffix characters.
  [/\bbpc_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, REDACTED_VALUE],
  // Well-known token prefixes: Backplane API keys, GitHub, GitLab, Slack and
  // sk- style model-provider keys.
  [
    /\b(?:vlr_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|sk-)[A-Za-z0-9_-]{8,}/g,
    REDACTED_VALUE,
  ],
  // URL userinfo: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED_VALUE}@`],
  // Every query or fragment value of a URL: signed URLs and OAuth callbacks
  // carry credentials there.
  [
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*[?#]\S*/gi,
    (url) => url.replace(/([?&#;][^=&#\s]*=)[^&#\s]*/g, `$1${REDACTED_VALUE}`),
  ],
  // key=value / key: value pairs for credential-named keys inside free text.
  [
    /\b((?:access|refresh|id|auth)?_?token|api[_-]?key|client[_-]?secret|passw(?:or)?d|secret)(\s*[=:]\s*)[^\s&"',;]+/gi,
    `$1$2${REDACTED_VALUE}`,
  ],
];

const utf8 = new TextEncoder();

function utf8ByteLength(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

// Splits camelCase, snake_case and kebab-case keys into lowercase words.
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) return true;
  // access_token, refreshToken, id_token; not input_tokens or token_count.
  if (words.at(-1) === "token") return true;
  const joined = words.join("");
  return joined.endsWith("apikey") || joined.endsWith("privatekey");
}

interface ProjectionState {
  limits: ProjectionLimits;
  nodesLeft: number;
  redacted: boolean;
  truncated: boolean;
}

function redactText(text: string, state: ProjectionState): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    redacted =
      typeof replacement === "string"
        ? redacted.replace(pattern, replacement)
        : redacted.replace(pattern, replacement);
  }
  if (redacted !== text) state.redacted = true;
  return redacted;
}

function projectString(value: string, state: ProjectionState): string {
  const { maxStringChars } = state.limits;
  const scanned = value.slice(0, maxStringChars + REDACTION_MARGIN_CHARS);
  const redacted = redactText(scanned, state);
  const visibleChars =
    scanned.length < value.length
      ? Math.max(0, Math.min(maxStringChars, redacted.length - REDACTION_MARGIN_CHARS))
      : maxStringChars;
  if (redacted.length <= visibleChars) return redacted;
  state.truncated = true;
  return `${redacted.slice(0, visibleChars)}…`;
}

function projectValue(value: unknown, depth: number, state: ProjectionState): unknown {
  if (state.nodesLeft <= 0) {
    state.truncated = true;
    return TRUNCATED_VALUE;
  }
  state.nodesLeft -= 1;
  if (typeof value === "string") return projectString(value, state);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return TRUNCATED_VALUE;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => projectValue(item, depth + 1, state));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.truncated = true;
      items.push(TRUNCATED_VALUE);
    }
    return items;
  }
  const projected: Record<string, unknown> = {};
  let keptKeys = 0;
  // for...in stops at the key limit without materializing a huge key list.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keptKeys === MAX_OBJECT_KEYS) {
      state.truncated = true;
      break;
    }
    keptKeys += 1;
    const field = (value as Record<string, unknown>)[key];
    const projectedKey = projectString(key, state);
    if (isCredentialKey(key) && field !== null && typeof field !== "boolean") {
      state.redacted = true;
      projected[projectedKey] = REDACTED_VALUE;
    } else {
      projected[projectedKey] = projectValue(field, depth + 1, state);
    }
  }
  return projected;
}

function envelopeText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_ENVELOPE_CHARS ? text.slice(0, MAX_ENVELOPE_CHARS) : text;
}

/**
 * A bounded, redacted copy of a delivered frame for diagnostic display. The
 * delivered frame is never mutated: ordinary subscribers receive it as sent.
 */
export function projectObserverFrame(event: WebSocketEvent): {
  frame: ObserverFrame;
  bytes: number;
} {
  const envelope = {
    event: envelopeText(event.event),
    timestamp: envelopeText(event.timestamp),
    event_id: envelopeText(event.event_id),
  };
  for (const limits of PROJECTION_ATTEMPTS) {
    const state: ProjectionState = {
      limits,
      nodesLeft: limits.maxNodes,
      redacted: false,
      truncated: false,
    };
    const frame: ObserverFrame = {
      ...envelope,
      payload: projectValue(event.payload ?? {}, 0, state) as Record<string, unknown>,
      projection: { redacted: state.redacted, truncated: state.truncated },
    };
    const bytes = utf8ByteLength(frame);
    if (bytes <= OBSERVER_FRAME_MAX_BYTES) return { frame, bytes };
  }
  const frame: ObserverFrame = {
    ...envelope,
    payload: {},
    projection: { redacted: false, truncated: true },
  };
  return { frame, bytes: utf8ByteLength(frame) };
}
