// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";

// Expansion is a plain `Record<nodeId, boolean>` rather than per-card booleans
// so it round-trips through JSON: the same map can later be persisted, deep
// linked (card 5), or handed to the north-star diagram view unchanged.
export type TreeExpansionState = Record<string, boolean>;

// Node ids for roles and steps ARE the draft `_dndId`s (`lcrole-*`, `lcstep-*`)
// so tree identity and dnd identity never diverge. Nodes with no draft entity
// of their own get these synthetic ids, namespaced away from both prefixes.
export function configNodeId(): string {
  return "tree:config";
}

export function schedulingNodeId(): string {
  return "tree:scheduling";
}

export function propertyGroupNodeId(ownerNodeId: string, group: string): string {
  return `tree:prop:${ownerNodeId}:${group}`;
}

// Property-group ids are DERIVED from an owner id, so a removed role or step
// orphans more keys than its own. Pruning by owner-prefix keeps both the
// expansion map and card 3's editing set free of ids no node can ever claim
// again — which matters because a re-added node can reuse a name-derived id
// and would otherwise inherit the dead node's open state.
export function isLiveNodeId(nodeId: string, liveIds: ReadonlySet<string>): boolean {
  if (liveIds.has(nodeId)) return true;
  const owner = nodeId.match(/^tree:prop:(.+):[^:]+$/)?.[1];
  return owner !== undefined && liveIds.has(owner);
}

export function pruneExpansion(
  expanded: TreeExpansionState,
  liveIds: readonly string[],
): TreeExpansionState {
  const live = new Set(liveIds);
  return Object.fromEntries(
    Object.entries(expanded).filter(([nodeId]) => isLiveNodeId(nodeId, live)),
  );
}

export function pruneNodeIds(
  ids: ReadonlySet<string>,
  liveIds: readonly string[],
): ReadonlySet<string> {
  const live = new Set(liveIds);
  return new Set([...ids].filter((nodeId) => isLiveNodeId(nodeId, live)));
}

export interface UsePipelineTreeStateOptions {
  defaultExpanded?: readonly string[];
}

export interface PipelineTreeState {
  expanded: TreeExpansionState;
  isExpanded: (nodeId: string) => boolean;
  toggle: (nodeId: string) => void;
  expandAll: (nodeIds: readonly string[]) => void;
  collapseAll: () => void;
  setExpanded: (next: TreeExpansionState) => void;
  prune: (liveIds: readonly string[]) => void;
}

function seed(defaultExpanded: readonly string[] = []): TreeExpansionState {
  return Object.fromEntries(defaultExpanded.map((id) => [id, true]));
}

export function usePipelineTreeState(
  options: UsePipelineTreeStateOptions = {},
): PipelineTreeState {
  const [expanded, setExpandedState] = useState<TreeExpansionState>(() =>
    seed(options.defaultExpanded),
  );

  const isExpanded = useCallback(
    (nodeId: string) => expanded[nodeId] === true,
    [expanded],
  );

  // Collapsing DELETES the key instead of writing `false`: the serialized map
  // then only ever names expanded nodes, which keeps a deep link short and
  // makes `{}` unambiguously "everything collapsed".
  const toggle = useCallback((nodeId: string) => {
    setExpandedState((prev) => {
      if (!prev[nodeId]) return { ...prev, [nodeId]: true };
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  }, []);

  const expandAll = useCallback((nodeIds: readonly string[]) => {
    setExpandedState((prev) => ({ ...prev, ...seed(nodeIds) }));
  }, []);

  const collapseAll = useCallback(() => setExpandedState({}), []);

  const setExpanded = useCallback(
    (next: TreeExpansionState) => setExpandedState({ ...next }),
    [],
  );

  // Identity-stable when nothing was orphaned, so callers can prune on every
  // draft change without forcing a re-render.
  const prune = useCallback((liveIds: readonly string[]) => {
    setExpandedState((prev) => {
      const next = pruneExpansion(prev, liveIds);
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, []);

  return { expanded, isExpanded, toggle, expandAll, collapseAll, setExpanded, prune };
}
