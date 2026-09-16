// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Code,
  FileText,
  Search,
  Trash2,
  UserPlus,
  Wrench,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/export-button";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/PageHeader";
import { AddTeamMemberDialog } from "./AddTeamMemberDialog";
import { PipelineDiagram } from "./PipelineDiagram";
import { TeamCompositions } from "./TeamCompositions";
import { useTeam, useDeactivateTeam, useRemoveTeamMember } from "../hooks/useTeams";
import { usePipelineConfig } from "../hooks/usePipelineConfig";
import { useBoards } from "@/features/kanban/api/use-boards";
import type { LucideIcon } from "lucide-react";

const ROLE_ICONS: Record<string, LucideIcon> = {
  orchestrator: Wrench,
  reviewer: Search,
  documentator: FileText,
};
const DEFAULT_ROLE_ICON: LucideIcon = Code;

export function TeamDetailPage() {
  const { slug = "", teamId = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const { data: team, isLoading, isError } = useTeam(slug, teamId);
  const { data: boards } = useBoards(slug);
  const { stagesByRole } = usePipelineConfig(slug);
  const deactivate = useDeactivateTeam(slug);
  const removeMember = useRemoveTeamMember(slug);

  const ROLE_CAPABILITIES = Object.entries(stagesByRole).map(([role, stage]) => ({
    role,
    icon: ROLE_ICONS[role] ?? DEFAULT_ROLE_ICON,
    descriptionKey: `teams.roleDescriptions.${role}`,
    stages: [stage.llm.stage].filter(Boolean),
  }));

  const boardName = team?.board_id
    ? boards?.find((b) => b.id === team.board_id)?.name
    : null;

  if (isLoading) {
    return <TeamDetailSkeleton />;
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(`/${slug}/runner/runners`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("agents.title")}
        </Button>
        <p className="text-sm text-destructive">{t("common.loadError")}</p>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(`/${slug}/runner/runners`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("agents.title")}
        </Button>
        <p className="text-sm text-muted-foreground">{t("common.notFound")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={team.name}
        description={team.description || undefined}
        eyebrow={
          <span className="flex items-center gap-2">
            {t("teams.teamDetail")}
            <Badge variant="outline" className="text-[0.6rem] normal-case tracking-normal">
              {team.members.length} {t("teams.members")}
            </Badge>
            <Badge variant="secondary" className="text-[0.6rem] normal-case tracking-normal">
              {t("teams.boardScope")}: {boardName ?? t("teams.allBoards")}
            </Badge>
            <InfoTooltip text={t("teams.boardScopeTooltip")} side="bottom" />
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {team.slug ? (
              <ExportButton
                endpoint={`/workspaces/${slug}/teams/${team.slug}/export`}
                defaultFilename={`${team.slug}.valaris.team.json`}
                entityLabel={t("export.entity.team")}
              />
            ) : null}
            <Button variant="ghost" onClick={() => navigate(`/${slug}/runner/runners`)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("agents.title")}
            </Button>
          </div>
        }
      />

      {/* Role capability cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {ROLE_CAPABILITIES.map((cap) => {
          const members = team.members.filter((m) => m.roles.includes(cap.role));
          return (
            <Card key={cap.role}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <cap.icon className="h-4 w-4" />
                  {t(`teams.roles.${cap.role}`, { defaultValue: cap.role })}
                  <InfoTooltip text={t(cap.descriptionKey)} side="bottom" />
                  {members.length > 0 ? (
                    <Badge variant="success" className="text-[0.6rem]">
                      {t("teams.filled")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[0.6rem]">
                      {t("teams.vacant")}
                    </Badge>
                  )}
                  {/* TODO(UX-1 follow-up): "executed in last 7d" badge. The
                      existing /workspaces/{slug}/teams/{id} response does not
                      include per-role recent activity counts. Plumb a derived
                      `recent_executions_by_role` field through TeamRead (or fan
                      out useExecutions filtered to this team's members) before
                      rendering. Skipping the badge keeps the card honest in the
                      meantime — better blank than fabricated. */}
                  <span
                    data-testid={`team-role-recent-todo-${cap.role}`}
                    className="hidden"
                    aria-hidden
                  />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  {t(cap.descriptionKey)}
                </p>
                {members.map((member) => (
                  <div key={member.agent_id} className="flex items-center gap-2 p-2 rounded bg-muted/50">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{member.agent_name}</span>
                    <Badge variant="outline" className="text-[0.6rem]">
                      {member.agent_type}
                    </Badge>
                  </div>
                ))}
                <div className="mt-3">
                  <p className="text-[0.6rem] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                    {t("teams.promptStages")}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {cap.stages.map((s) => (
                      <code
                        key={s}
                        className="text-[0.6rem] bg-muted px-1 py-0.5 rounded"
                      >
                        {s}
                      </code>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <PipelineDiagram />

      <TeamCompositions
        currentRoles={team.members.flatMap((m) => m.roles)}
      />

      {/* Members list */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{t("teams.members")}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddOpen(true)}
            >
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {t("teams.addMember")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {team.members.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("teams.empty")}
            </p>
          ) : (
            team.members.map((member) => (
              <div
                key={member.agent_id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{member.agent_name}</span>
                  {member.roles.map((role) => {
                    const warning = member.role_warnings?.find(
                      (w) => w.role === role,
                    );
                    const roleLabel = t(`teams.roles.${role}`, {
                      defaultValue: role,
                    });
                    return (
                      <span key={role} className="inline-flex items-center gap-1">
                        <Badge variant="secondary">{roleLabel}</Badge>
                        {warning && (
                          <Tooltip>
                            <TooltipTrigger>
                              <AlertTriangle
                                className="h-3.5 w-3.5 text-amber-500"
                                aria-label={t(
                                  "teams.roleWarnings.notInPipelineAria",
                                  { role },
                                )}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" variant="info">
                              {t("teams.roleWarnings.notInPipeline")}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    );
                  })}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    removeMember.mutate({
                      teamId: team.id,
                      agentId: member.agent_id,
                    })
                  }
                  title={t("teams.removeMember")}
                  aria-label={t("a11y.agents.removeMember")}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Quick links */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => navigate(`/${slug}/runner/pipeline`)}
        >
          <Code className="mr-2 h-4 w-4" />
          {t("prompts.title")}
        </Button>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            deactivate.mutate(team.id, {
              onSuccess: () => navigate(`/${slug}/runner/runners`),
            });
          }}
          disabled={deactivate.isPending}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("teams.deactivate")}
        </Button>
      </div>

      <AddTeamMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        slug={slug}
        teamId={teamId}
        teamName={team.name}
        existingMembers={team.members}
      />
    </div>
  );
}

function TeamDetailSkeleton() {
  return (
    <div className="space-y-[var(--page-section-gap)]">
      <Skeleton className="h-24 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
    </div>
  );
}
