// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { BoardsOverview } from "../../ipc/bindings";

// encodeURIComponent keeps "." and "..", which a browser resolves as path steps.
const isPathSegment = (segment: string) => segment !== "" && segment !== "." && segment !== "..";

/**
 * Where a board gets created on the web: the only workspace's boards page
 * (its create button is there), else the web app's root. Only the account's
 * web origin counts: `endpoint` is the API and may not serve the web app.
 */
export function createBoardUrl(webOrigin: string | null | undefined, catalog: BoardsOverview | null): string | null {
  if (!webOrigin) return null;
  let root: string;
  try {
    root = new URL(webOrigin).origin;
  } catch {
    return null;
  }
  const [only, ...others] = catalog?.workspaces ?? [];
  if (only && others.length === 0 && isPathSegment(only.slug)) return `${root}/${encodeURIComponent(only.slug)}/boards`;
  return `${root}/`;
}
