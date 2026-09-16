// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";

// What the inspector is currently focused on. `step` carries the parent role so
// the inspector can open that role's step editor scrolled to the step.
export type CanvasSelection =
  | { kind: "role"; nodeId: string }
  | { kind: "lane"; nodeId: string }
  | { kind: "step"; nodeId: string; roleNodeId: string }
  | null;

// Canvas-local UI state: which role boxes are expanded (showing their lifecycle
// step graph), which role is focused (zoom target), and the inspector selection.
// Deliberately NOT part of the draft — this is view state, not config.
export function useCanvasNodeState() {
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
  const [focusedRole, setFocusedRole] = useState<string | null>(null);
  const [selection, setSelection] = useState<CanvasSelection>(null);

  const toggleRole = useCallback((nodeId: string) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const expandRole = useCallback((nodeId: string) => {
    setExpandedRoles((prev) => new Set(prev).add(nodeId));
  }, []);

  const focusRole = useCallback(
    (nodeId: string) => {
      setFocusedRole(nodeId);
      expandRole(nodeId);
    },
    [expandRole],
  );

  const clearFocus = useCallback(() => setFocusedRole(null), []);

  const collapseAll = useCallback(() => {
    setExpandedRoles(new Set());
    setFocusedRole(null);
  }, []);

  const select = useCallback((sel: CanvasSelection) => setSelection(sel), []);

  return {
    expandedRoles,
    focusedRole,
    selection,
    toggleRole,
    expandRole,
    focusRole,
    clearFocus,
    collapseAll,
    select,
  };
}
