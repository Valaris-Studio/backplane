// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// GitHub OAuth scopes are dot/colon-separated strings. Two related concerns:
//   1. Strip the `read:` / `write:` qualifier when present so "read:org" and
//      "write:org" both render as "Org".
//   2. Map a known whitelist to a human label; anything unknown falls back to
//      a Title-Cased version of the raw scope so we never lose information.
const HUMAN_SCOPE_LABELS: Record<string, string> = {
  repo: "Repositories",
  "public_repo": "Public repositories",
  workflow: "Workflow actions",
  user: "User profile",
  email: "Email address",
  org: "Organizations",
  notifications: "Notifications",
  gist: "Gists",
  packages: "Packages",
};

function stripQualifier(scope: string): string {
  const colonIndex = scope.indexOf(":");
  if (colonIndex === -1) return scope;
  return scope.slice(colonIndex + 1);
}

function titleCase(scope: string): string {
  return scope
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatScope(scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed) return "";
  const base = stripQualifier(trimmed).toLowerCase();
  return HUMAN_SCOPE_LABELS[base] ?? titleCase(base);
}

export function formatScopeList(scopes: string[]): string {
  const labels = scopes
    .map(formatScope)
    .filter((s) => s.length > 0);
  // De-dupe — "repo" + "public_repo" can both appear; we keep both labels but
  // collapse exact duplicates (e.g. "read:org" + "admin:org" → "Org" twice).
  const unique = Array.from(new Set(labels));
  return unique.join(" + ");
}
