// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { cn } from "@/lib/utils";

// Display-only inline chip for an inserted mention. Pill `primary` aesthetic
// (bg-primary/14 text-primary, rounded-full) but NOT uppercase — inline reading
// flow, sober. No GSAP; any future motion must be scale/opacity only (GSAP
// cannot tween color-mix — notification-system rule).
export function MentionView({ node }: NodeViewProps) {
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
  return (
    <NodeViewWrapper
      as="span"
      data-mention=""
      data-mention-id={node.attrs.id ?? undefined}
      className={cn(
        "inline-flex items-center rounded-full bg-primary/14 px-1.5 py-px",
        "align-baseline text-[0.92em] font-medium leading-none text-primary",
      )}
    >
      @{label}
    </NodeViewWrapper>
  );
}
