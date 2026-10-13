// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mirrors the backend SLUG_FORMAT that WorkspaceCreate enforces.
const WORKSPACE_SLUG_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WORKSPACE_SLUG_MAX_LENGTH = 255;

export function isValidWorkspaceSlug(slug: string): boolean {
  return (
    slug.length <= WORKSPACE_SLUG_MAX_LENGTH && WORKSPACE_SLUG_FORMAT.test(slug)
  );
}

export function toWorkspaceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, WORKSPACE_SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
}
