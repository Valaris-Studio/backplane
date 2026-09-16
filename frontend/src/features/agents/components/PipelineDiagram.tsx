// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import { usePipelineConfig } from "../hooks/usePipelineConfig";

const COLUMN_ORDER = ["backlog", "active", "review", "done"] as const;
const COLUMN_LABELS: Record<string, string> = {
  backlog: "To Do",
  active: "In Progress",
  review: "Review",
  done: "Done",
};

export function PipelineDiagram() {
  const { t } = useTranslation();
  const { slug = "" } = useParams<{ slug: string }>();
  const { pipelineConfig, roleBgColorMap } = usePipelineConfig(slug);

  const steps = useMemo(() => {
    const roleByColumn: Record<string, string> = {};
    for (const stage of pipelineConfig?.stages ?? []) {
      if (stage.discover.column_type) {
        roleByColumn[stage.discover.column_type] = stage.role;
      }
    }

    return COLUMN_ORDER.map((col) => ({
      column: COLUMN_LABELS[col] ?? col,
      columnType: col,
      agent: roleByColumn[col] ?? null,
      color: roleByColumn[col]
        ? (roleBgColorMap[roleByColumn[col]] ?? "bg-muted")
        : "bg-muted",
    }));
  }, [pipelineConfig, roleBgColorMap]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {t("teams.pipeline")}
          <InfoTooltip text={t("teams.pipelineTooltip")} side="right" />
        </CardTitle>
        <CardDescription>{t("teams.pipelineDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1">
          {steps.map((step, i) => (
            <Fragment key={step.columnType}>
              {i > 0 && (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <div
                className={cn(
                  "flex-1 rounded-lg p-3 text-center min-w-0",
                  step.color,
                )}
              >
                <p className="text-sm font-medium truncate">{step.column}</p>
                {step.agent && (
                  <Badge variant="outline" className="mt-1 text-[0.6rem]">
                    {t(`teams.roles.${step.agent}`, { defaultValue: step.agent })}
                  </Badge>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
