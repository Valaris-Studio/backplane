// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { UnboundLaneNodeData } from "../canvasTypes";

// The lane for configured-but-unbound roles: same group-box behavior as a runner
// lane (children placed inside by the layout engine) but styled in warning tones
// to flag that no runner claims these roles.
export function UnboundLaneNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as UnboundLaneNodeData;

  return (
    <div className="relative h-full w-full rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-dashed border-[color:var(--color-warning)]/60 bg-[color:var(--color-warning)]/[0.06]">
      <div className="flex h-11 items-center gap-2 rounded-t-[inherit] border-b border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10 px-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-[color:var(--color-warning-foreground)]">
            {t("pipelineGraph.canvas.unboundRoles")}
          </span>
          <span className="truncate text-[0.65rem] text-muted-foreground">
            {t("pipelineGraph.canvas.unboundRolesHint")}
          </span>
        </div>
        <Badge
          variant="warning"
          className="ml-auto shrink-0 px-1.5 py-0 text-[0.6rem] normal-case tracking-normal"
        >
          {d.roleCount}
        </Badge>
      </div>
    </div>
  );
}
