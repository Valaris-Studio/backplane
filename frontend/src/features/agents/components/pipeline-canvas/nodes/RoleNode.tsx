// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { type NodeProps } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Crosshair,
  OctagonX,
  Unlink,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  ROLE_NODE_HEIGHT,
  ROLE_NODE_WIDTH,
} from "@/features/agents/utils/lifecycle-graph-layout";
import type { RoleNodeData } from "../canvasTypes";
import { useCanvasActions } from "../CanvasActionsContext";

// A role card inside a runner lane. Roles are INDEPENDENT — there are no edges
// between them, so this node carries NO source/target handles. Cross-role
// relations (wake_role targets, column handoffs) surface only as chips. When
// collapsed the card is fixed-size; when expanded it becomes a titled container
// whose lifecycle-step children are placed inside by the layout engine.
export function RoleNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { onSelectRole, onToggleRole, onFocusRole, onBindRole } = useCanvasActions();
  const d = data as RoleNodeData;

  const hasError = d.errorCount > 0;

  return (
    <div
      style={
        d.expanded ? { minWidth: ROLE_NODE_WIDTH } : { width: ROLE_NODE_WIDTH, height: ROLE_NODE_HEIGHT }
      }
      className={cn(
        "relative flex flex-col rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border bg-card shadow-soft transition-colors",
        d.expanded ? "h-full" : null,
        hasError
          ? "border-destructive/70 ring-1 ring-destructive/40"
          : d.hasStrand
            ? "border-destructive/70 bg-destructive/5"
            : "border-border/80 hover:border-primary/60",
      )}
    >
      {/* Breathing ring while this role is the runner's in-flight role. */}
      {d.working && !reducedMotion ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-[color:var(--color-info)]/50"
          initial={{ opacity: 0.3 }}
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : null}

      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          aria-label={d.expanded ? t("pipelineGraph.canvas.collapse") : t("pipelineGraph.canvas.expand")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRole?.(id);
          }}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {d.expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onSelectRole?.(id)}
          className="min-w-0 flex-1 truncate text-left font-mono text-sm font-semibold text-card-foreground transition-colors hover:text-primary"
          title={d.role}
        >
          {d.role}
        </button>

        {d.hasStrand ? (
          <OctagonX
            className="h-3.5 w-3.5 shrink-0 text-destructive"
            aria-label={t("pipelineGraph.strand")}
          />
        ) : null}
        {d.hasDangling ? (
          <Unlink
            className="h-3.5 w-3.5 shrink-0 text-destructive"
            aria-label={t("pipelineGraph.healthDangling", { count: 1 })}
          />
        ) : null}
        {d.missingFailureFallback ? (
          <CircleDot
            className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-warning)]"
            aria-label={t("pipelineGraph.noFailureFallback")}
          />
        ) : null}
        {hasError ? (
          <Badge
            variant="destructive"
            className="shrink-0 px-1.5 py-0 text-[0.6rem] normal-case tracking-normal"
            aria-label={t("pipelineGraph.canvas.validationOnNode", { count: d.errorCount })}
          >
            {d.errorCount}
          </Badge>
        ) : null}

        {/* Unbound roles have no runner — offer to bind one right here so the
            gap lane is actionable, not just a warning. */}
        {d.unbound ? (
          <button
            type="button"
            aria-label={t("pipelineGraph.canvas.bindRunner")}
            title={t("pipelineGraph.canvas.bindRunner")}
            onClick={(e) => {
              e.stopPropagation();
              onBindRole?.(d.role);
            }}
            className="shrink-0 rounded-md p-0.5 text-[color:var(--color-warning)] transition-colors hover:bg-[color:var(--color-warning)]/10"
          >
            <UserPlus className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <button
          type="button"
          aria-label={t("pipelineGraph.canvas.focus")}
          title={t("pipelineGraph.canvas.focus")}
          onClick={(e) => {
            e.stopPropagation();
            onFocusRole?.(id);
          }}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Crosshair className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Cross-role chips — the ONLY representation of role-to-role relations. */}
      {!d.expanded && (d.wakes.length > 0 || d.handsTo.length > 0) ? (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2">
          {d.wakes.map((role) => (
            <span
              key={`wake-${role}`}
              className="rounded-[var(--radius-cap)] border border-[color:var(--color-info)]/40 bg-[color:var(--color-info)]/10 px-1.5 py-px text-[0.6rem] font-medium text-[color:var(--color-info-foreground)]"
            >
              {t("pipelineGraph.canvas.wakes", { role })}
            </span>
          ))}
          {d.handsTo.map((column) => (
            <span
              key={`hands-${column}`}
              className="rounded-[var(--radius-cap)] border border-border/70 bg-muted/60 px-1.5 py-px text-[0.6rem] font-medium text-muted-foreground"
            >
              {t("pipelineGraph.canvas.handsTo", { column })}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
