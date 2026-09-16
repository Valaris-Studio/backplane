// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useTeams, useAddTeamMember, useRemoveTeamMember } from "../../hooks/useTeams";
import { RoleCombobox } from "../teams/RoleCombobox";

interface RunnerBindingEditorProps {
  slug: string;
  agentId: string | null;
  /** Configured pipeline roles — the combobox suggestion set (truthful). */
  configuredRoles: string[];
}

// Edit which pipeline roles a runner claims, from the canvas. Backed entirely by
// the existing team hooks — TeamMemberAdd REPLACES the member's role set, so
// add/remove always sends the full desired list. A role not in the pipeline is
// surfaced as a warning chip (role_warnings from the backend).
export function RunnerBindingEditor({
  slug,
  agentId,
  configuredRoles,
}: RunnerBindingEditorProps) {
  const { t } = useTranslation();
  const { data: teams } = useTeams(slug);
  const addMember = useAddTeamMember(slug);
  const removeMember = useRemoveTeamMember(slug);

  // Find every (team, membership) this runner has; the first is the edit target.
  const memberships = useMemo(() => {
    if (!agentId || !teams) return [];
    return teams.flatMap((team) =>
      team.members
        .filter((m) => m.agent_id === agentId)
        .map((m) => ({ team, member: m })),
    );
  }, [teams, agentId]);

  if (!agentId) return null;

  const primary = memberships[0];
  const selectedRoles = primary?.member.roles ?? [];
  const warnings = primary?.member.role_warnings ?? [];
  const agentName = primary?.member.agent_name ?? agentId;

  const applyRoles = (roles: string[]) => {
    if (!primary) return;
    addMember.mutate({
      teamId: primary.team.id,
      data: { agent_id: agentId, roles },
      memberName: agentName,
      teamName: primary.team.name,
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="runner-binding-editor">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {agentName}
        </span>
      </div>

      {!primary ? (
        <p className="text-xs text-muted-foreground">
          {t("pipelineGraph.canvas.binding.noTeam")}
        </p>
      ) : (
        <>
          <label className="text-xs font-medium text-muted-foreground">
            {t("pipelineGraph.canvas.binding.rolesLabel")}
          </label>
          <RoleCombobox
            suggestions={configuredRoles}
            selectedRoles={selectedRoles}
            onAdd={(role) => applyRoles([...selectedRoles, role])}
            onRemove={(role) => {
              const next = selectedRoles.filter((r) => r !== role);
              if (next.length === 0) {
                removeMember.mutate({ teamId: primary.team.id, agentId });
              } else {
                applyRoles(next);
              }
            }}
          />
          {selectedRoles.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("pipelineGraph.canvas.binding.anyRoleHint")}
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {warnings.map((w) => (
                <span
                  key={w.role}
                  className="flex items-center gap-1 rounded-full border border-[color:var(--color-warning)]/50 bg-[color:var(--color-warning)]/10 px-2 py-0.5 text-[0.65rem] text-[color:var(--color-warning)]"
                >
                  <AlertTriangle className="h-3 w-3" />
                  {t("pipelineGraph.canvas.binding.notInPipeline", { role: w.role })}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
