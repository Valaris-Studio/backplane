// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";

interface AdvancedSectionProps {
  title: string;
  hint?: string;
  /** Render expanded on first mount (e.g. when the section has unsaved attention). */
  defaultOpen?: boolean;
  children: ReactNode;
}

// A progressive-disclosure wrapper: collapses rarely-touched power-user config
// (rate limits, budget, key rotation, raw DSL) behind one click so the default
// view stays focused on the 20% that matters. Everything stays reachable — this
// hides, never removes.
export function AdvancedSection({ title, hint, defaultOpen = false, children }: AdvancedSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))] border border-border/70 bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/30"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        {title}
        {hint ? (
          <span className="text-xs font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-[var(--page-section-gap)] border-t border-border/60 p-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
