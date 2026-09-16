// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The region a TreePill owns. Children mount only while open — a collapsed
 * subtree costs nothing, which matters because a role's step editors are heavy.
 *
 * The id is derived from the node id so a pill can point `aria-controls` at it
 * without either side threading a generated id through props.
 */
export function treeDisclosureId(nodeId: string): string {
  return `tree-disclosure-${nodeId}`;
}

export interface TreeDisclosureProps {
  nodeId: string;
  open: boolean;
  children: ReactNode;
  className?: string;
}

export function TreeDisclosure({
  nodeId,
  open,
  children,
  className,
}: TreeDisclosureProps) {
  if (!open) return null;
  return (
    <div
      id={treeDisclosureId(nodeId)}
      // The WAI-ARIA tree pattern's owned group: a treeitem's children live in
      // a `group`, which is what lets a screen reader announce depth and size.
      role="group"
      // motion-safe: the reveal is skipped wholesale under prefers-reduced-motion
      // rather than tuned down, matching the repo's existing animate-pop-in usage.
      className={cn("motion-safe:animate-tree-reveal", className)}
    >
      {children}
    </div>
  );
}
