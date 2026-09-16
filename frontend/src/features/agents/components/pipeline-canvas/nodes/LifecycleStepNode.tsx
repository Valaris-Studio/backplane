// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleDot, Diamond, OctagonX, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STAGE_NODE_HEIGHT,
  STAGE_NODE_WIDTH,
  type StageNodeData,
} from "@/features/agents/utils/lifecycle-graph-layout";
import { useCanvasActions } from "../CanvasActionsContext";

// A single lifecycle step inside an expanded role box. Mirrors the old
// PipelineGraphView StageNode exactly (same handles, kind label, decision/
// terminal/strand/missing markers) so the drill-in reads identically; the only
// additions are `roleNodeId` (which role owns this step) + the click handler.
export type LifecycleStepNodeData = StageNodeData & { roleNodeId: string };

export function LifecycleStepNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const { onSelectStep } = useCanvasActions();
  const d = data as LifecycleStepNodeData;
  const isMissing = d.kind === "missing";

  return (
    <div
      style={{ width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT }}
      onClick={() => onSelectStep?.(id, d.roleNodeId)}
      className={cn(
        "flex cursor-pointer flex-col justify-center gap-1 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border px-3 py-2 text-left shadow-soft transition-colors",
        isMissing
          ? "border-dashed border-destructive bg-destructive/10"
          : d.strand
            ? "border-destructive bg-destructive/10"
            : "border-border/80 bg-card hover:border-primary/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-border !border-card" />
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate text-sm font-medium",
            d.strand || isMissing ? "text-destructive" : "text-card-foreground",
          )}
          title={d.label}
        >
          {d.label}
        </span>
        <span className="shrink-0 text-[0.6rem] uppercase tracking-wide text-muted-foreground">
          {isMissing ? t("pipelineGraph.missing") : d.kind}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {d.producesDecision ? (
          <Diamond
            className="h-3 w-3 text-[color:var(--color-info)]"
            aria-label={t("pipelineGraph.decision")}
          />
        ) : null}
        {d.terminal ? (
          <Square
            className="h-3 w-3 fill-current text-muted-foreground"
            aria-label={t("pipelineGraph.terminal")}
          />
        ) : null}
        {d.strand ? (
          <span className="text-[0.6rem] font-semibold text-destructive">
            {t("pipelineGraph.strand")}
          </span>
        ) : null}
        {d.missingFailureFallback ? (
          <CircleDot
            className="h-3 w-3 text-[color:var(--color-warning)]"
            aria-label={t("pipelineGraph.noFailureFallback")}
          />
        ) : null}
        {isMissing ? (
          <OctagonX
            className="h-3 w-3 text-destructive"
            aria-label={t("pipelineGraph.missing")}
          />
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-border !border-card" />
    </div>
  );
}
