// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseUnifiedDiff } from "@/lib/unified-diff";
import type { DiffRowType } from "@/lib/line-diff";
import type { LoopBindingDiff } from "@/features/kanban/api/use-board-loop-binding";

// Same token pair LineDiff uses, so the two diff surfaces in the product are
// visually one thing. Kept here rather than exported from LineDiff because
// that component owns a before/after contract this one deliberately does not.
const ROW_CLASS: Record<DiffRowType, string> = {
  eq: "text-muted-foreground",
  add: "bg-success/15 text-[color:var(--color-success-foreground)]",
  del: "bg-destructive/15 text-destructive",
};

const MARKER: Record<DiffRowType, string> = { eq: " ", add: "+", del: "-" };

const PROMPT_FIELDS = ["system_prompt", "loop_prompt"] as const;

/**
 * Renders the kernel diff the BACKEND computed for a drifted binding.
 *
 * `GET /loop/binding/diff` ships unified-diff text, so this cannot reuse
 * `LineDiff` (which diffs a before/after pair itself). Re-deriving the diff
 * client-side would risk showing something other than what the backend
 * considers drifted, so the server's answer is rendered verbatim.
 */
export function BoundDiffPanel({ diff }: { diff: LoopBindingDiff }) {
  const { t } = useTranslation();
  const { added, removed } = diff.slots_delta;

  return (
    <div className="space-y-3" data-testid="bound-diff">
      {PROMPT_FIELDS.map((field) => {
        // Empty string is the backend's "unchanged" signal — an empty diff box
        // would read as "this prompt was emptied".
        if (!diff[field]) return null;
        const rows = parseUnifiedDiff(diff[field]);
        return (
          <div key={field} className="space-y-1">
            <p className="text-xs font-medium">
              {t(`boardLoop.templates.bound.drift.field.${field}`)}
            </p>
            <div
              data-testid={`bound-diff-${field}`}
              className="overflow-x-auto rounded-md border font-mono text-xs"
            >
              {rows.map((row, index) => (
                <div
                  key={`${index}-${row.type}`}
                  className={cn("flex gap-2 px-2 py-0.5", ROW_CLASS[row.type])}
                >
                  <span aria-hidden="true" className="w-2 shrink-0 select-none">
                    {MARKER[row.type]}
                  </span>
                  <span className="whitespace-pre-wrap break-all">{row.line}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {added.length > 0 && (
        <p className="text-xs" data-testid="bound-diff-slots-added">
          {t("boardLoop.templates.bound.drift.slotsAdded", {
            slots: added.join(", "),
          })}
        </p>
      )}
      {removed.length > 0 && (
        <p className="text-xs" data-testid="bound-diff-slots-removed">
          {t("boardLoop.templates.bound.drift.slotsRemoved", {
            slots: removed.join(", "),
          })}
        </p>
      )}
    </div>
  );
}
