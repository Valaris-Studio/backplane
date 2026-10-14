// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { LocalSession, SessionTokens } from "../../ipc/bindings";

const MINUTE_MS = 60_000;

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 100_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

// A clock behind the daemon's, or an unparseable timestamp, reads as zero.
const nonNegative = (ms: number) => (Number.isFinite(ms) ? Math.max(0, ms) : 0);

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(nonNegative(elapsedMs) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

export function formatMinutes(durationMs: number): string {
  return `${Math.round(nonNegative(durationMs) / MINUTE_MS)} min`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatClockTime(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

export type CostBasis = "api_equivalent" | "spend";

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  api_equivalent: "API‑equivalent",
  spend: "spend",
};

export const COST_BASIS_HELP: Record<CostBasis, string> = {
  api_equivalent: "API-equivalent: what these tokens would cost at API list prices. On a subscription you are not billed this amount.",
  spend: "Spend: billed to the API key this agent uses.",
};

export const UNKNOWN_COST_HELP = "The cost isn’t known for this session yet.";

function isCostBasis(value: string | null): value is CostBasis {
  return value === "api_equivalent" || value === "spend";
}

const finiteOrNull = (usd: number | null | undefined) => (typeof usd === "number" && Number.isFinite(usd) ? usd : null);

type CostFacts = Pick<LocalSession, "cost_estimated_usd" | "cost_basis"> & { cost_reported_usd?: number | null };

/**
 * The server's effective cost: what the agent reported, else the list-price
 * estimate. Shown only with its basis: an unlabelled dollar figure would read as a bill.
 */
export function costOf(session: CostFacts): { usd: number; basis: CostBasis } | null {
  const usd = finiteOrNull(session.cost_reported_usd) ?? finiteOrNull(session.cost_estimated_usd);
  if (usd === null || !isCostBasis(session.cost_basis)) return null;
  return { usd, basis: session.cost_basis };
}

export function totalTokens(tokens: SessionTokens | null): number {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
}

// A cold prompt cache (Anthropic's expires after an idle hour) re-sends the whole
// conversation as one cache write. The floor keeps a new session's first write of
// its system prompt, which dominates just as much, from reading as a re-send.
export const COLD_CACHE_WRITE_SHARE = 0.5;
export const COLD_CACHE_MIN_WRITE_TOKENS = 100_000;

export function cacheWasRebuilt(tokens: SessionTokens | null): boolean {
  if (!tokens || tokens.cache_write < COLD_CACHE_MIN_WRITE_TOKENS) return false;
  const inputSide = tokens.input + tokens.cache_read + tokens.cache_write;
  return tokens.cache_write / inputSide >= COLD_CACHE_WRITE_SHARE;
}

/** Captured, but the agent hasn't reported usage yet: nothing to show beyond that. */
export function usagePending(session: CostFacts & Pick<LocalSession, "tokens">): boolean {
  return totalTokens(session.tokens) === 0 && costOf(session) === null;
}

// Exactly host/owner/repo from plain name characters. That rules out userinfo (@),
// schemes and scp remotes (:), local paths (/, ~), whitespace and control characters.
const NORMALIZED_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const MAX_REPO_LENGTH = 255;

// "." and ".." are path traversal, and a leading "-" reads as a command-line flag.
const unsafeSegment = (segment: string) => segment === "." || segment === ".." || segment.startsWith("-");

/** The repo only when it is a plain host/owner/repo; anything else could carry a token or a path. */
export function safeRepo(repo: string | null): string | null {
  if (!repo || repo.length > MAX_REPO_LENGTH) return null;
  const trimmed = repo.replace(/\.git$/, "");
  if (!NORMALIZED_REPO.test(trimmed) || trimmed.split("/").some(unsafeSegment)) return null;
  return trimmed;
}

/** owner/repo; the host is noise in a 360px row. */
export function repoLabel(repo: string | null): string {
  const safe = safeRepo(repo);
  return safe ? safe.slice(safe.indexOf("/") + 1) : "No git remote";
}
