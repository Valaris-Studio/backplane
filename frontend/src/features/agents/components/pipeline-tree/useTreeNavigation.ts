// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isLiveNodeId } from "./usePipelineTreeState";

// Roving tabindex + arrow traversal for the pill tree (WAI-ARIA tree pattern).
//
// The walk reads the LIVE DOM rather than a mirrored model of the tree: the
// visible pills are exactly `[data-node-id]` in document order, which is the
// render order, and collapsed subtrees are unmounted so they drop out for free.
// Rebuilding that ordering in JS would mean a second source of truth that has
// to be kept in step with every future node kind — the DOM already answers it.

export interface TreeNavigation {
  /** The node that owns the single tab stop; null before any focus. */
  focusedNodeId: string | null;
  isTabbable: (nodeId: string, isFirstNode: boolean) => boolean;
  onNodeFocus: (nodeId: string) => void;
  handleKeyDown: (
    event: KeyboardEvent<HTMLElement>,
    node: { nodeId: string; expanded: boolean; toggleable: boolean },
  ) => void;
  /** Focus a node on a later paint, once expansion has mounted it. */
  focusNodeSoon: (nodeId: string) => void;
}

export interface UseTreeNavigationOptions {
  /** Container that scopes the pill query — the tree's own root. */
  containerRef: { current: HTMLElement | null };
  expand: (nodeId: string) => void;
  collapse: (nodeId: string) => void;
  /** Every node id the draft can still justify; drives focus pruning. */
  liveNodeIds: readonly string[];
}

function pillsIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>("[data-node-id]"));
}

function nodeIdOf(pill: HTMLElement): string {
  return pill.getAttribute("data-node-id") ?? "";
}

export function useTreeNavigation({
  containerRef,
  expand,
  collapse,
  liveNodeIds,
}: UseTreeNavigationOptions): TreeNavigation {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  // Set by ArrowRight/deep-link: the node to focus once the expansion that
  // mounts it has painted. A ref because it must not itself trigger a render.
  const pendingFocus = useRef<string | null>(null);

  // A removed node must not keep the tab stop, or Tab lands on nothing and the
  // tree becomes unreachable. Same pruning rule as expansion and editing.
  useEffect(() => {
    setFocusedNodeId((prev) =>
      prev === null || isLiveNodeId(prev, new Set(liveNodeIds)) ? prev : null,
    );
  }, [liveNodeIds]);

  const focusNode = useCallback(
    (nodeId: string) => {
      const target = pillsIn(containerRef.current).find(
        (pill) => nodeIdOf(pill) === nodeId,
      );
      if (!target) return false;
      target.focus();
      setFocusedNodeId(nodeId);
      return true;
    },
    [containerRef],
  );

  const focusNodeSoon = useCallback((nodeId: string) => {
    pendingFocus.current = nodeId;
  }, []);

  // Runs after every render, so a node that only just mounted (expansion, deep
  // link) is focusable by the time we reach for it.
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    if (focusNode(wanted)) pendingFocus.current = null;
  });

  const isTabbable = useCallback(
    (nodeId: string, isFirstNode: boolean) =>
      focusedNodeId === null ? isFirstNode : focusedNodeId === nodeId,
    [focusedNodeId],
  );

  const onNodeFocus = useCallback((nodeId: string) => setFocusedNodeId(nodeId), []);

  const handleKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLElement>,
      node: { nodeId: string; expanded: boolean; toggleable: boolean },
    ) => {
      const pills = pillsIn(containerRef.current);
      const index = pills.findIndex((pill) => nodeIdOf(pill) === node.nodeId);
      if (index === -1) return;

      const moveTo = (target: HTMLElement | undefined) => {
        if (!target) return;
        event.preventDefault();
        target.focus();
        setFocusedNodeId(nodeIdOf(target));
      };

      switch (event.key) {
        case "ArrowDown":
          moveTo(pills[index + 1]);
          return;
        case "ArrowUp":
          moveTo(pills[index - 1]);
          return;
        case "Home":
          moveTo(pills[0]);
          return;
        case "End":
          moveTo(pills[pills.length - 1]);
          return;
        case "ArrowRight":
          // Expand in place first; only a second press steps INTO the subtree,
          // which is what makes Right a safe repeat key while drilling down.
          if (!node.toggleable) return;
          event.preventDefault();
          if (node.expanded) {
            const child = pills[index + 1];
            // The next pill in document order is this node's first child only
            // while the node is open — that is the definition of the walk.
            if (child) {
              child.focus();
              setFocusedNodeId(nodeIdOf(child));
            }
          } else {
            expand(node.nodeId);
          }
          return;
        case "ArrowLeft": {
          event.preventDefault();
          // Mirror of Right: collapse an open node, otherwise step OUT to the
          // nearest shallower pill. Depth is read off the DOM nesting rather
          // than tracked, so it cannot disagree with what is rendered.
          if (node.toggleable && node.expanded) {
            collapse(node.nodeId);
            return;
          }
          moveTo(parentPillOf(pills[index]));
          return;
        }
        default:
      }
    },
    [containerRef, expand, collapse],
  );

  return { focusedNodeId, isTabbable, onNodeFocus, handleKeyDown, focusNodeSoon };
}

// Each node renders inside a `data-tree-node` wrapper that also contains its
// disclosure, so "step out" is just the nearest ENCLOSING wrapper's own pill.
// Reading nesting off the DOM keeps depth from becoming a second thing to
// maintain as node kinds are added.
function parentPillOf(pill: HTMLElement | undefined): HTMLElement | undefined {
  const wrapper = pill?.closest("[data-tree-node]")?.parentElement?.closest<HTMLElement>(
    "[data-tree-node]",
  );
  return wrapper?.querySelector<HTMLElement>("[data-node-id]") ?? undefined;
}
