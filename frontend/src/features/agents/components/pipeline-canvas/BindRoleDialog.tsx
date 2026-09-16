// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentMetrics } from "../../hooks/useAgentMetrics";
import { useTeams, useCreateTeam, useAddTeamMember } from "../../hooks/useTeams";

interface BindRoleDialogProps {
  slug: string;
  /** The configured-but-unbound role to attach to a runner. */
  role: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Escape hatch when there's no runner to bind — opens the create wizard. */
  onCreateRunner: () => void;
}

// Bind a runner to a configured-but-unbound role, straight from the canvas gap
// lane. Picks an active runner and sends the UNION of its existing roles + this
// role — POST /teams/{id}/members REPLACES the member's whole role set, so a
// naive [role] would silently drop everything the runner already claims. A
// runner in no team gets the default team created first (mirrors the wizard's
// BindStep).
export function BindRoleDialog({
  slug,
  role,
  open,
  onOpenChange,
  onCreateRunner,
}: BindRoleDialogProps) {
  const { t } = useTranslation();
  const { data: metrics } = useAgentMetrics(slug);
  const { data: teams } = useTeams(slug);
  const createTeam = useCreateTeam(slug);
  const addMember = useAddTeamMember(slug);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const activeRunners = useMemo(
    () => (metrics ?? []).filter((m) => m.is_active),
    [metrics],
  );

  const bind = () => {
    const runner = activeRunners.find((r) => r.agent_id === selectedAgentId);
    if (!runner) return;

    // Find the runner's membership across every team (first wins as edit target)
    // so we send the union against ITS current roles, not a blank set.
    const membership = teams
      ?.flatMap((team) => team.members.map((m) => ({ team, member: m })))
      .find((entry) => entry.member.agent_id === runner.agent_id);

    const nextRoles = membership
      ? Array.from(new Set([...membership.member.roles, role]))
      : [role];

    const doAdd = (teamId: string, teamName: string) =>
      addMember.mutate(
        {
          teamId,
          data: { agent_id: runner.agent_id, roles: nextRoles },
          memberName: runner.name,
          teamName,
        },
        { onSuccess: () => onOpenChange(false) },
      );

    if (membership) {
      doAdd(membership.team.id, membership.team.name);
    } else if (teams && teams.length > 0) {
      doAdd(teams[0]!.id, teams[0]!.name);
    } else {
      createTeam.mutate(
        { name: t("runner.launchWizard.defaultTeamName") },
        { onSuccess: (team) => doAdd(team.id, team.name) },
      );
    }
  };

  const pending = addMember.isPending || createTeam.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-primary" />
            {t("pipelineGraph.canvas.bind.title", { role })}
          </DialogTitle>
          <DialogDescription>{t("pipelineGraph.canvas.bind.subtitle")}</DialogDescription>
        </DialogHeader>

        {activeRunners.length === 0 ? (
          <div className="space-y-4" data-testid="bind-empty">
            <p className="text-sm text-muted-foreground">
              {t("pipelineGraph.canvas.bind.emptyHint")}
            </p>
            <Button
              onClick={() => {
                onOpenChange(false);
                onCreateRunner();
              }}
              data-testid="bind-empty-create"
            >
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {t("pipelineGraph.canvas.bind.createRunner")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {activeRunners.map((runner) => {
                const selected = runner.agent_id === selectedAgentId;
                return (
                  <button
                    key={runner.agent_id}
                    type="button"
                    data-testid={`bind-runner-option-${runner.agent_id}`}
                    onClick={() => setSelectedAgentId(runner.agent_id)}
                    aria-pressed={selected}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      selected
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border/70 hover:border-border hover:bg-muted/40",
                    )}
                  >
                    <span className="truncate font-mono font-medium">{runner.name}</span>
                    {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={bind}
                disabled={!selectedAgentId || pending}
                data-testid="bind-confirm"
              >
                {pending ? t("common.saving") : t("pipelineGraph.canvas.bind.confirm")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
