// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Home's strict rule (screens/home/format.ts), copied so the two screens stay independent.
// Exactly host/owner/repo from plain name characters. That rules out userinfo (@),
// schemes and scp remotes (:), local paths (/, ~), whitespace and control characters.
const NORMALIZED_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const MAX_REPO_LENGTH = 255;

// "." and ".." are path traversal, and a leading "-" reads as a command-line flag.
const unsafeSegment = (segment: string) => segment === "." || segment === ".." || segment.startsWith("-");

/** The repo only when it is a plain host/owner/repo; anything else could carry a token or a path. */
export function safeRepo(repo: string | null | undefined): string | null {
  if (!repo || repo.length > MAX_REPO_LENGTH) return null;
  const trimmed = repo.replace(/\.git$/, "");
  if (!NORMALIZED_REPO.test(trimmed) || trimmed.split("/").some(unsafeSegment)) return null;
  return trimmed;
}

export function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}
