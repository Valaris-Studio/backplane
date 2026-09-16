// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Users } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTeams, useAddTeamMember, useCreateTeam } from "../hooks/useTeams";
import { usePipelineConfig } from "../hooks/usePipelineConfig";
import { RoleCombobox } from "./teams/RoleCombobox";
import type { TeamRead, TeamMemberRead } from "../api/teams";

interface RunnerRoleBindingCardProps {
  slug: string;
  agentId: string;
  agentName?: string;
}

// The 80%-path answer to "which roles can THIS runner take" — a runner-centric
// editor over the AgentTeamMember.roles the scheduler reads, sidestepping the
// Team → member → dialog ceremony. A runner may belong to several teams; each
// membership carries its own role set, so we render one editor row per team.
export function RunnerRoleBindingCard({
  slug,
  agentId,
  agentName,
}: RunnerRoleBindingCardProps) {
  const { t } = useTranslation();
  const { data: teams, isLoading } = useTeams(slug);
  const { roles: pipelineRoles } = usePipelineConfig(slug);

  const memberships = useMemo(
    () =>
      (teams ?? [])
        .map((team) => ({
          team,
          member: team.members.find((m) => m.agent_id === agentId),
        }))
        .filter(
          (m): m is { team: TeamRead; member: TeamMemberRead } => !!m.member,
        ),
    [teams, agentId],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("runnerRoles.title")}</CardTitle>
        <CardDescription>{t("runnerRoles.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-8 w-24" />
          </div>
        ) : memberships.length > 0 ? (
          memberships.map(({ team, member }) => (
            <MembershipEditor
              key={team.id}
              slug={slug}
              team={team}
              member={member}
              agentId={agentId}
              agentName={agentName}
              pipelineRoles={pipelineRoles}
            />
          ))
        ) : (
          <EmptyState
            slug={slug}
            agentId={agentId}
            agentName={agentName}
            teams={teams ?? []}
            pipelineRoles={pipelineRoles}
          />
        )}
      </CardContent>
    </Card>
  );
}

interface MembershipEditorProps {
  slug: string;
  team: TeamRead;
  member: TeamMemberRead;
  agentId: string;
  agentName?: string;
  pipelineRoles: string[];
}

function MembershipEditor({
  slug,
  team,
  member,
  agentId,
  agentName,
  pipelineRoles,
}: MembershipEditorProps) {
  const { t } = useTranslation();
  const addMember = useAddTeamMember(slug);
  const [roles, setRoles] = useState<string[]>(member.roles);

  const addRole = (role: string) => {
    const normalized = role.trim();
    if (!normalized) return;
    setRoles((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  };
  const removeRole = (role: string) => {
    setRoles((prev) => prev.filter((r) => r !== role));
  };

  const dirty =
    roles.length !== member.roles.length ||
    roles.some((r) => !member.roles.includes(r));

  const save = () => {
    // Upsert: replaces this membership's role set with the edited list.
    addMember.mutate({
      teamId: team.id,
      data: { agent_id: agentId, roles },
      memberName: agentName ?? member.agent_name,
      teamName: team.name,
    });
  };

  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-border/60 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Users className="h-4 w-4 text-muted-foreground" />
        {t("runnerRoles.inTeam", { team: team.name })}
      </div>
      {/* Surface backend role warnings outside the chip input so they remain
          visible even while the user edits the draft role list. */}
      {member.role_warnings?.length > 0 && (
        <ul className="space-y-1">
          {member.role_warnings.map((w) => (
            <li
              key={w.role}
              className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-label={t("runnerRoles.notInPipelineWarning", {
                        role: w.role,
                      })}
                    />
                    {t("teams.roles." + w.role, { defaultValue: w.role })}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" variant="info">
                  {t("teams.roleWarnings.notInPipeline")}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          {t("runnerRoles.rolesLabel")}
        </label>
        <RoleCombobox
          suggestions={pipelineRoles}
          selectedRoles={roles}
          onAdd={addRole}
          onRemove={removeRole}
        />
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || addMember.isPending}
        >
          {addMember.isPending
            ? t("runnerRoles.saving")
            : t("runnerRoles.save")}
        </Button>
      </div>
    </div>
  );
}

interface EmptyStateProps {
  slug: string;
  agentId: string;
  agentName?: string;
  teams: TeamRead[];
  pipelineRoles: string[];
}

function EmptyState({
  slug,
  agentId,
  agentName,
  teams,
  pipelineRoles,
}: EmptyStateProps) {
  if (teams.length === 0) {
    return <CreateTeamAffordance slug={slug} />;
  }

  return (
    <AddToTeamAffordance
      slug={slug}
      agentId={agentId}
      agentName={agentName}
      teams={teams}
      pipelineRoles={pipelineRoles}
    />
  );
}

function AddToTeamAffordance({
  slug,
  agentId,
  agentName,
  teams,
  pipelineRoles,
}: {
  slug: string;
  agentId: string;
  agentName?: string;
  teams: TeamRead[];
  pipelineRoles: string[];
}) {
  const { t } = useTranslation();
  const addMember = useAddTeamMember(slug);
  const [teamId, setTeamId] = useState("");
  const [roles, setRoles] = useState<string[]>([]);

  const addRole = (role: string) => {
    const normalized = role.trim();
    if (!normalized) return;
    setRoles((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  };
  const removeRole = (role: string) => {
    setRoles((prev) => prev.filter((r) => r !== role));
  };

  const add = () => {
    if (!teamId || roles.length === 0) return;
    const team = teams.find((tm) => tm.id === teamId);
    addMember.mutate(
      {
        teamId,
        data: { agent_id: agentId, roles },
        memberName: agentName,
        teamName: team?.name,
      },
      {
        onSuccess: () => {
          setRoles([]);
          setTeamId("");
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <Users className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">{t("runnerRoles.noTeamTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("runnerRoles.noTeamDescription")}
          </p>
        </div>
      </div>
      <Select value={teamId} onValueChange={setTeamId}>
        <SelectTrigger>
          <SelectValue placeholder={t("runnerRoles.selectTeam")} />
        </SelectTrigger>
        <SelectContent>
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RoleCombobox
        suggestions={pipelineRoles}
        selectedRoles={roles}
        onAdd={addRole}
        onRemove={removeRole}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={add}
          disabled={!teamId || roles.length === 0 || addMember.isPending}
        >
          {t("runnerRoles.addToTeam")}
        </Button>
      </div>
    </div>
  );
}

function CreateTeamAffordance({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const createTeam = useCreateTeam(slug);
  const [name, setName] = useState("");

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createTeam.mutate({ name: trimmed }, { onSuccess: () => setName("") });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <Users className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">{t("runnerRoles.noTeamTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("runnerRoles.createTeamPrompt")}
          </p>
        </div>
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("runnerRoles.teamNamePlaceholder")}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={create}
          disabled={!name.trim() || createTeam.isPending}
        >
          {t("runnerRoles.createTeam")}
        </Button>
      </div>
    </div>
  );
}
