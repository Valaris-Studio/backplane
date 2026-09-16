// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { LifecycleStep } from "@/features/agents/api/pipelineConfig";
import {
  effectiveProducesDecision,
  KIND_SEMANTICS,
} from "@/features/agents/utils/lifecycle-graph";

interface StageParamPanelProps {
  step: LifecycleStep;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="break-words text-sm text-foreground">{value}</span>
    </div>
  );
}

/**
 * Read-only peek at a lifecycle step's config — bridges the graph to the form
 * editor. Renders the step's transitions + its kind-specific params (flattened
 * from `params`) so a reader can see WHAT a node does without leaving the graph.
 */
export function StageParamPanel({ step, onClose }: StageParamPanelProps) {
  const { t } = useTranslation();
  const sem = KIND_SEMANTICS[step.kind];
  const params = (step.params ?? {}) as Record<string, unknown>;

  const paramEntries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card p-4 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{step.name}</h3>
          <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            {step.kind}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {effectiveProducesDecision(step) ? (
          <span className="rounded-full bg-[color:var(--color-info)]/15 px-2 py-0.5 text-[0.6rem] font-medium text-[color:var(--color-info)]">
            {t("pipelineGraph.decision")}
          </span>
        ) : null}
        {sem?.terminal ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[0.6rem] font-medium text-muted-foreground">
            {t("pipelineGraph.terminal")}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2.5">
        {paramEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("pipelineGraph.noParams")}</p>
        ) : (
          paramEntries.map(([key, value]) => (
            <Row
              key={key}
              label={key}
              value={
                typeof value === "object" ? (
                  <code className="text-xs">{JSON.stringify(value)}</code>
                ) : (
                  String(value)
                )
              }
            />
          ))
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border/60 pt-3">
        {step.next ? <Row label={t("pipelineGraph.onSuccess")} value={step.next} /> : null}
        {step.branches && Object.keys(step.branches).length > 0 ? (
          <Row
            label={t("pipelineGraph.branches")}
            value={
              <span className="flex flex-col gap-0.5">
                {Object.entries(step.branches).map(([d, target]) => (
                  <span key={d} className="text-xs">
                    <span className="font-medium">{d}</span> → {target}
                  </span>
                ))}
              </span>
            }
          />
        ) : null}
        {step.on_failure ? (
          <Row
            label={t("pipelineGraph.onFailure")}
            value={<span className="text-[color:var(--color-warning)]">{step.on_failure}</span>}
          />
        ) : null}
      </div>
    </aside>
  );
}
