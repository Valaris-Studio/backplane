// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeams, useDeactivateTeam, useRemoveTeamMember } from "../hooks/useTeams";
import { CreateTeamDialog } from "./CreateTeamDialog";
import { AddTeamMemberDialog } from "./AddTeamMemberDialog";
import type { TeamRead } from "../api/teams";

interface TeamPanelProps {
  slug: string;
}

export function TeamPanel({ slug }: TeamPanelProps) {
  const { t } = useTranslation();
  const { data: teams, isLoading, isError } = useTeams(slug);
  const [createOpen, setCreateOpen] = useState(false);

  if (isLoading) {
    return <Skeleton className="h-52 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{t("teams.title")}</CardTitle>
          {/* Same CTA spec as the Runners tab's Create runner — the two
              create-entity buttons must read as siblings. */}
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("teams.create")}
          </Button>
        </CardHeader>
        <CardContent>
          {isError ? (
            <p className="text-sm text-destructive">{t("common.loadError")}</p>
          ) : !teams?.length ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <Users className="h-8 w-8" />
              <p className="text-sm">{t("teams.empty")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {teams.map((team) => (
                <TeamCard key={team.id} team={team} slug={slug} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateTeamDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        slug={slug}
      />
    </>
  );
}

function TeamCard({ team, slug }: { team: TeamRead; slug: string }) {
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const deactivate = useDeactivateTeam(slug);
  const removeMember = useRemoveTeamMember(slug);

  return (
    <>
      <div className="rounded-lg border border-border/60 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Team name is plain text: the legacy /teams/:id detail page
                  ejected the console shell and its unique content (a hardcoded
                  role-capability grid) is exactly the drift this redesign
                  removed — capabilities now derive from the live pipeline in the
                  Pipeline graph. Add-member / deactivate stay inline below. */}
              <span className="font-medium">{team.name}</span>
              <Badge variant="outline" className="text-xs">
                {team.members.length} {t("teams.members")}
              </Badge>
            </div>
            {team.description && (
              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                {team.description}
              </p>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setAddOpen(true)}
              title={t("teams.addMember")}
              aria-label={t("a11y.agents.addMember")}
            >
              <UserPlus className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => deactivate.mutate(team.id)}
              title={t("teams.deactivate")}
              aria-label={t("a11y.agents.deactivateTeam")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {team.members.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {team.members.map((member) => (
              <Badge
                key={member.agent_id}
                variant="secondary"
                className="text-xs gap-1 pr-1"
              >
                {member.agent_name}
                <RichTooltip i18nKey="runners.team.roleAssignment" side="top">
                  <span className="text-muted-foreground">
                    {member.roles.map((r) => t(`teams.roles.${r}`, { defaultValue: r })).join(", ")}
                  </span>
                </RichTooltip>
                <button
                  className="ml-0.5 rounded-full p-0.5 hover:bg-muted"
                  onClick={() =>
                    removeMember.mutate({ teamId: team.id, agentId: member.agent_id })
                  }
                  title={t("teams.removeMember")}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <AddTeamMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        slug={slug}
        teamId={team.id}
        existingMembers={team.members}
      />
    </>
  );
}
