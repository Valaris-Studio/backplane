// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentMetrics } from "../hooks/useAgentMetrics";
import { useAddTeamMember } from "../hooks/useTeams";
import { usePipelineConfig } from "../hooks/usePipelineConfig";
import { RoleCombobox } from "./teams/RoleCombobox";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import type { TeamRole, TeamMemberRead } from "../api/teams";

interface AddTeamMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  teamId: string;
  teamName?: string;
  existingMembers: TeamMemberRead[];
}

export function AddTeamMemberDialog({
  open,
  onOpenChange,
  slug,
  teamId,
  teamName,
  existingMembers,
}: AddTeamMemberDialogProps) {
  const { t, i18n } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<TeamRole[]>([]);
  const [error, setError] = useState<unknown>(null);
  const errorMessage =
    error === null ? null : resolveApiErrorMessage(error, t, i18n);
  const { data: agents } = useAgentMetrics(slug);
  const addMember = useAddTeamMember(slug);
  const { roles: pipelineRoles } = usePipelineConfig(slug);

  const existingMember = existingMembers.find((m) => m.agent_id === agentId);

  const addRole = useCallback((role: string) => {
    const normalized = role.trim();
    if (!normalized) return;
    setSelectedRoles((prev) =>
      prev.includes(normalized) ? prev : [...prev, normalized],
    );
  }, []);

  const removeRole = useCallback((role: string) => {
    setSelectedRoles((prev) => prev.filter((r) => r !== role));
  }, []);

  const handleAgentChange = (id: string) => {
    setAgentId(id);
    const member = existingMembers.find((m) => m.agent_id === id);
    setSelectedRoles(member ? [...member.roles] : []);
  };

  const handleClose = () => {
    onOpenChange(false);
    setAgentId("");
    setSelectedRoles([]);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || selectedRoles.length === 0) return;

    setError(null);
    const member = agents?.find((a) => a.agent_id === agentId);
    addMember.mutate(
      {
        teamId,
        data: { agent_id: agentId, roles: selectedRoles },
        memberName: member?.name,
        teamName,
      },
      {
        onSuccess: handleClose,
        onError: setError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("teams.addMember")}</DialogTitle>
          <DialogDescription>{t("teams.addMemberDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("teams.selectAgent")}</label>
            <Select value={agentId} onValueChange={handleAgentChange}>
              <SelectTrigger>
                <SelectValue placeholder={t("teams.selectAgentPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {agents?.map((agent) => (
                  <SelectItem key={agent.agent_id} value={agent.agent_id}>
                    {agent.name} ({t(`agents.types.${agent.agent_type}`)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {existingMember && (
              <p className="text-xs text-muted-foreground">
                {t("teams.multiRole")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="role-combobox">
              {t("teams.roles_label")}
            </label>
            <RoleCombobox
              suggestions={pipelineRoles}
              selectedRoles={selectedRoles}
              onAdd={addRole}
              onRemove={removeRole}
            />
            <p className="text-xs text-muted-foreground">
              {t("teams.addMember.customRoleHint")}
            </p>
          </div>
          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!agentId || selectedRoles.length === 0 || addMember.isPending}
            >
              {addMember.isPending ? t("common.adding") : t("teams.addMember")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
