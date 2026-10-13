// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export type ServerUrlProblem = "empty" | "not_https" | "invalid" | "extras";
export type ServerUrlCheck = { ok: true; url: string } | { ok: false; reason: ServerUrlProblem };

// Plain HTTP only to a literal loopback IP (never "localhost"), and only in dev builds (contract v1.4).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** Mirrors the daemon's endpoint rules (uplink.validateEndpoint) and returns the URL in the form it stores. */
export function validateServerUrl(raw: string, options: { allowLoopbackHttp?: boolean } = {}): ServerUrlCheck {
  const allowLoopbackHttp = options.allowLoopbackHttp ?? import.meta.env.DEV;
  const candidate = raw.trim();
  if (!candidate) return { ok: false, reason: "empty" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(candidate)?.[1]?.toLowerCase();
  if (scheme !== "https" && scheme !== "http") return { ok: false, reason: "not_https" };
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (scheme === "http" && !(allowLoopbackHttp && LOOPBACK_HOSTS.has(parsed.hostname))) return { ok: false, reason: "not_https" };
  if (!parsed.hostname || parsed.hostname.includes("..") || parsed.username || parsed.password) return { ok: false, reason: "invalid" };
  // A trailing "?" or "#" parses to an empty search/hash, so check the text as well.
  if (parsed.search || parsed.hash || /[?#]/.test(candidate)) return { ok: false, reason: "extras" };
  return { ok: true, url: parsed.toString().replace(/\/$/, "") };
}

export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
