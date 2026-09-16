// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { usePipelineConfig } from "../hooks/usePipelineConfig";

interface Composition {
  nameKey: string;
  descKey: string;
  roles: string[];
}

interface TeamCompositionsProps {
  currentRoles: string[];
}

function rolesMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...a].sort();
  const sortedB = [...b].sort();
  return sorted.every((role, i) => role === sortedB[i]);
}

export function TeamCompositions({ currentRoles }: TeamCompositionsProps) {
  const { t } = useTranslation();
  const { slug = "" } = useParams<{ slug: string }>();
  const { roles: pipelineRoles } = usePipelineConfig(slug);

  const compositions = useMemo<Composition[]>(() => {
    if (pipelineRoles.length === 0) return [];
    const result: Composition[] = [
      {
        nameKey: "teams.compositions.standard.name",
        descKey: "teams.compositions.standard.desc",
        roles: [...pipelineRoles],
      },
    ];
    if (pipelineRoles.length > 2) {
      result.push({
        nameKey: "teams.compositions.minimal.name",
        descKey: "teams.compositions.minimal.desc",
        roles: pipelineRoles.slice(0, 2),
      });
    }
    if (pipelineRoles.length > 1) {
      result.push({
        nameKey: "teams.compositions.reviewOnly.name",
        descKey: "teams.compositions.reviewOnly.desc",
        roles: [pipelineRoles[1]!],
      });
    }
    return result;
  }, [pipelineRoles]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {t("teams.compositions.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {compositions.map((comp) => {
            const isActive = rolesMatch(currentRoles, comp.roles);
            return (
              <div
                key={comp.nameKey}
                className={cn(
                  "rounded-lg border p-3 transition-colors",
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-border bg-muted/30",
                )}
              >
                <p className="text-sm font-medium mb-1">{t(comp.nameKey)}</p>
                <p className="text-xs text-muted-foreground mb-2">
                  {t(comp.descKey)}
                </p>
                <div className="flex flex-wrap gap-1">
                  {comp.roles.map((role) => (
                    <Badge
                      key={role}
                      variant={isActive ? "default" : "outline"}
                      className="text-[0.6rem]"
                    >
                      {t(`teams.roles.${role}`, { defaultValue: role })}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
