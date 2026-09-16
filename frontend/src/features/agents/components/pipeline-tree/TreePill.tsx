// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LifecycleKindName } from "../../api/pipelineConfig";
import { treeDisclosureId } from "./TreeDisclosure";
import { stepAccentFor, treeNodeAccentFor, type TreeNodeKind } from "./treeTaxonomy";

export interface TreePillProps {
  /** Taxonomy bucket — drives the accent and, later, the diagram node shape. */
  nodeKind: TreeNodeKind;
  /**
   * Role and step nodes pass their draft `_dndId`; synthetic nodes pass an id
   * from usePipelineTreeState. Also derives the `aria-controls` target.
   */
  nodeId: string;
  label: string;
  /** Lifecycle kind of a `step` node — accents by kind family rather than generically. */
  stepKind?: LifecycleKindName;
  /** Terse right-of-label context, e.g. "4 steps" or a target column. */
  summary?: ReactNode;
  /** Count or error chip; callers pass a Badge. */
  badge?: ReactNode;
  /**
   * Cumulative validation errors at or below this node. Mirrored onto
   * `data-error-count` so "a collapsed ancestor still advertises the problem"
   * is assertable without depending on how the badge happens to render.
   */
  errorCount?: number;
  icon?: ReactNode;
  expanded?: boolean;
  /** Absent ⇒ leaf node: no chevron, no aria-expanded, still focusable. */
  onToggle?: () => void;
  className?: string;
  /**
   * Roving tabindex: exactly one pill in the tree is tabbable at a time, so Tab
   * enters and leaves the whole tree in one stop and arrows move within it.
   * Absent ⇒ the pill is not part of a roving group and stays natively tabbable.
   */
  tabbable?: boolean;
  onFocus?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

export function TreePill({
  nodeKind,
  nodeId,
  label,
  stepKind,
  summary,
  badge,
  errorCount,
  icon,
  expanded,
  onToggle,
  className,
  tabbable,
  onFocus,
  onKeyDown,
}: TreePillProps) {
  const accent =
    nodeKind === "step" && stepKind
      ? stepAccentFor(stepKind)
      : treeNodeAccentFor(nodeKind);

  const isToggleable = typeof onToggle === "function";
  const inRovingGroup = tabbable !== undefined;

  return (
    <button
      type="button"
      // A native <button> gives Enter AND Space activation for free; handling
      // keydown manually here would double-fire on Enter.
      onClick={onToggle}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      // `treeitem` only INSIDE a role="tree" container — which is exactly when
      // the pill joins the roving group. A pill rendered standalone stays a
      // plain button, because a lone treeitem is invalid ARIA, not a nicety.
      role={inRovingGroup ? "treeitem" : undefined}
      tabIndex={inRovingGroup ? (tabbable ? 0 : -1) : undefined}
      aria-expanded={isToggleable ? expanded === true : undefined}
      aria-controls={
        isToggleable && expanded ? treeDisclosureId(nodeId) : undefined
      }
      data-node-id={nodeId}
      data-node-kind={nodeKind}
      data-error-count={
        errorCount !== undefined && errorCount > 0 ? errorCount : undefined
      }
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm font-medium",
        "transition-[background-color,border-color,box-shadow] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isToggleable && "hover:brightness-105",
        accent.className,
        className,
      )}
    >
      {isToggleable ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-150",
            expanded && "rotate-90",
          )}
        />
      ) : null}
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="truncate">{label}</span>
      {summary ? (
        <span className="truncate text-xs font-normal opacity-75">{summary}</span>
      ) : null}
      {badge ? <span className="ml-auto shrink-0 pl-1">{badge}</span> : null}
    </button>
  );
}
