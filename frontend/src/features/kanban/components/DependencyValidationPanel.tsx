// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BoardDependencyValidation } from "@/types/kanban";

interface DependencyValidationPanelProps {
  validation: BoardDependencyValidation | undefined;
  /** Focus/open a card by id when an issue referencing it is clicked. */
  onFocusCard?: (cardId: string) => void;
  className?: string;
}

interface IssueRowProps {
  summary: string;
  cardId: string | null;
  onFocusCard?: (cardId: string) => void;
}

function IssueRow({ summary, cardId, onFocusCard }: IssueRowProps) {
  const clickable = cardId != null && onFocusCard != null;
  return (
    <li>
      <button
        type="button"
        disabled={!clickable}
        onClick={clickable ? () => onFocusCard!(cardId!) : undefined}
        className={cn(
          "w-full rounded-md px-2 py-1.5 text-left text-sm text-destructive/90",
          clickable && "hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:outline-none",
          !clickable && "cursor-default",
        )}
      >
        {summary}
      </button>
    </li>
  );
}

export function DependencyValidationPanel({
  validation,
  onFocusCard,
  className,
}: DependencyValidationPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  if (!validation) return null;

  const cycleCount = validation.cycles.length;
  const conflictCount = validation.conflicts.length;
  const orphanCount = validation.orphans.length;
  const issueCount = cycleCount + conflictCount + orphanCount;

  if (validation.ok || issueCount === 0) {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-success/30 bg-success/10 px-3 py-2 text-sm text-[color:var(--color-success)]",
          className,
        )}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>{t("kanban.dependencyValidation.healthy")}</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-destructive/40 bg-destructive/10",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-destructive"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {t("kanban.dependencyValidation.issues", { count: issueCount })}
        </span>
        <span className="ml-1 text-xs font-normal text-destructive/80">
          {[
            cycleCount > 0 && t("kanban.dependencyValidation.cycleCount", { count: cycleCount }),
            conflictCount > 0 && t("kanban.dependencyValidation.conflictCount", { count: conflictCount }),
            orphanCount > 0 && t("kanban.dependencyValidation.orphanCount", { count: orphanCount }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 shrink-0 text-destructive/70 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-3 px-3 pb-3">
          {cycleCount > 0 ? (
            <section>
              <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-destructive/80">
                {t("kanban.dependencyValidation.cyclesHeading")}
              </h4>
              <ul className="mt-1">
                {validation.cycles.map((cycle, i) => (
                  <IssueRow
                    key={`cycle-${i}`}
                    summary={cycle.summary}
                    cardId={cycle.card_ids[0] ?? null}
                    onFocusCard={onFocusCard}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {conflictCount > 0 ? (
            <section>
              <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-destructive/80">
                {t("kanban.dependencyValidation.conflictsHeading")}
              </h4>
              <ul className="mt-1">
                {validation.conflicts.map((conflict) => (
                  <IssueRow
                    key={`conflict-${conflict.card_id}`}
                    summary={conflict.summary}
                    cardId={conflict.card_id}
                    onFocusCard={onFocusCard}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {orphanCount > 0 ? (
            <section>
              <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-destructive/80">
                {t("kanban.dependencyValidation.orphansHeading")}
              </h4>
              <ul className="mt-1">
                {validation.orphans.map((orphan, i) => (
                  <IssueRow
                    key={`orphan-${i}`}
                    summary={orphan.summary}
                    cardId={orphan.card_on_board ? orphan.card_id : null}
                    onFocusCard={onFocusCard}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
