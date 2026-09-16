// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { type NodeProps } from "@xyflow/react";
import { Pencil, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { RunnerLaneNodeData } from "../canvasTypes";
import { useCanvasActions } from "../CanvasActionsContext";

// A runner swimlane: a labeled bounding box whose child role nodes are placed
// inside by the layout engine (we render the frame + header only). The body is
// transparent/dashed so the child role cards show through the group.
export function RunnerLaneNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { onLaunchRunner, onEditRoles } = useCanvasActions();
  const d = data as RunnerLaneNodeData;

  const alive = d.liveness === "alive";
  const livenessLabel = alive
    ? t("pipelineGraph.canvas.liveness.alive")
    : t("pipelineGraph.canvas.liveness.offline");

  return (
    <div className="relative h-full w-full rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-dashed border-border/70 bg-card/20">
      {/* Breathing ring while the runner is actively working (reduced-motion off). */}
      {d.working && !reducedMotion ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-[color:var(--color-info)]/40"
          initial={{ opacity: 0.25 }}
          animate={{ opacity: [0.25, 0.7, 0.25] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : null}

      <div className="flex h-11 items-center gap-2 rounded-t-[inherit] border-b border-border/60 bg-card/70 px-3">
        <span
          aria-label={livenessLabel}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            alive ? "bg-[color:var(--color-success)]" : "bg-muted-foreground/50",
            alive && !reducedMotion ? "animate-pulse" : null,
          )}
        />
        <span className="truncate font-mono text-sm font-semibold text-card-foreground">
          {d.agentName}
        </span>
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[0.6rem] normal-case tracking-normal">
          {d.roleCount}
        </Badge>
        {d.claimsAllRoles ? (
          <Badge variant="info" className="shrink-0 px-1.5 py-0 text-[0.55rem] normal-case tracking-normal">
            {t("pipelineGraph.canvas.anyRole")}
          </Badge>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t("pipelineGraph.canvas.editRoles")}
            title={t("pipelineGraph.canvas.editRoles")}
            onClick={() => onEditRoles?.(d.agentId)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("pipelineGraph.canvas.launchRunner")}
            title={t("pipelineGraph.canvas.launchRunner")}
            onClick={() => onLaunchRunner?.(d.agentId)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Rocket className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
