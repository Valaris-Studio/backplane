// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useCallback } from "react";

import { boardOfSession, useBoardsCatalog, useMappings, type SessionCapture } from "../../stores/projects";

export type SessionBoardName = (session: SessionCapture) => string | undefined;

/** Names a session's row after the board that captured it, by the same rule as its link. */
export function useSessionBoardName(): SessionBoardName {
  const mappings = useMappings();
  const catalog = useBoardsCatalog();
  return useCallback((session) => (catalog ? boardOfSession(catalog, mappings, session)?.boardName : undefined), [mappings, catalog]);
}
