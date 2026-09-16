// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { diffLines, type DiffRowType } from "@/lib/line-diff";

// Tint only the changed rows: an all-tinted diff hides its own signal. The
// `-foreground` tokens are the theme-corrected pair for these tinted surfaces
// (index.css:313), so a dark theme keeps its contrast without a second class.
const ROW_CLASS: Record<DiffRowType, string> = {
  eq: "text-muted-foreground",
  add: "bg-success/15 text-[color:var(--color-success-foreground)]",
  del: "bg-destructive/15 text-destructive",
};

const MARKER: Record<DiffRowType, string> = { eq: " ", add: "+", del: "-" };

interface LineDiffProps {
  before: string;
  after: string;
  /** Labels the two sides for screen readers; the tab supplies version numbers. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Unified line diff of two prompt bodies.
 *
 * Unified rather than side-by-side because prompt lines are long prose, and two
 * 50-character columns wrap every line into unreadability at the widths this
 * tab actually gets.
 */
export function LineDiff({ before, after, ariaLabel, className }: LineDiffProps) {
  const { t } = useTranslation();
  const diff = useMemo(() => diffLines(before, after), [before, after]);

  if (diff.tooLarge) {
    return (
      <p
        data-testid="line-diff-too-large"
        className="text-muted-foreground rounded-md border border-dashed p-3 text-xs"
      >
        {t("lineDiff.tooLarge")}
      </p>
    );
  }

  if (diff.added === 0 && diff.removed === 0) {
    return (
      <p
        data-testid="line-diff-identical"
        className="text-muted-foreground rounded-md border border-dashed p-3 text-xs"
      >
        {t("lineDiff.identical")}
      </p>
    );
  }

  return (
    <div
      data-testid="line-diff"
      aria-label={ariaLabel}
      className={cn("overflow-x-auto rounded-md border font-mono text-xs", className)}
    >
      {diff.rows.map((row, index) => (
        <div
          key={`${index}-${row.type}`}
          data-testid={`line-diff-row-${index}`}
          className={cn("flex gap-2 px-2 py-0.5", ROW_CLASS[row.type])}
        >
          <span
            aria-hidden="true"
            data-testid={`line-diff-marker-${index}`}
            className="w-2 shrink-0 select-none"
          >
            {MARKER[row.type]}
          </span>
          <span className="whitespace-pre-wrap break-all">{row.line}</span>
        </div>
      ))}
    </div>
  );
}
