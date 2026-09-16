// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  Pause,
  Play,
  Power,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useDeactivateAgent,
  useHardDeleteAgent,
  usePauseAgent,
  usePollAgent,
  useRestartAgent,
  useResumeAgent,
  useUpdateAgent,
} from "../hooks/useAgentMetrics";

interface AgentLifecycleMenuProps {
  slug: string;
  agentId: string;
  name: string;
  isActive: boolean;
  isPaused: boolean;
}

/**
 * Per-runner lifecycle actions, collapsed behind one trigger.
 *
 * The pre-2026-08 table exposed a bare destructive-red Power icon wired
 * straight to DELETE /agents/{id}. It is a *soft* disable, but the affordance
 * read as "delete the runner" and fired on a single stray click — an operator
 * once could not tell whether their runner still existed. Every state-changing
 * action now names what it does, and the one that stops work asks first and
 * says how to undo it.
 *
 * An inactive runner offers only Re-enable: pausing or disabling something
 * already disabled is a no-op the menu should not pretend to offer.
 */
export function AgentLifecycleMenu({
  slug,
  agentId,
  name,
  isActive,
  isPaused,
}: AgentLifecycleMenuProps) {
  const { t } = useTranslation();
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [confirmingHardDelete, setConfirmingHardDelete] = useState(false);

  const pause = usePauseAgent(slug);
  const resume = useResumeAgent(slug);
  const poll = usePollAgent(slug);
  const deactivate = useDeactivateAgent(slug);
  const restart = useRestartAgent(slug);
  const hardDelete = useHardDeleteAgent(slug);
  const updateAgent = useUpdateAgent(slug);

  return (
    // Row-level onClick navigates to the runner detail; the menu is inside that
    // row, so every interaction here has to stop bubbling or opening the menu
    // would navigate away from the table.
    <span onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("agents.lifecycle.menuLabel")}
          aria-label={t("a11y.agents.runnerActions")}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {isActive ? (
            <>
              <DropdownMenuItem
                onClick={() =>
                  isPaused ? resume.mutate(agentId) : pause.mutate(agentId)
                }
              >
                {isPaused ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                {isPaused
                  ? t("agents.lifecycle.resume")
                  : t("agents.lifecycle.pause")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => poll.mutate(agentId)}>
                <RadioTower className="h-3.5 w-3.5" />
                {t("agents.lifecycle.pollNow")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setConfirmingRestart(true)}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("agents.lifecycle.restart")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setConfirmingDisable(true)}
              >
                <Power className="h-3.5 w-3.5" />
                {t("agents.lifecycle.disable")}
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem
                onClick={() =>
                  updateAgent.mutate({ agentId, data: { is_active: true } })
                }
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("agents.lifecycle.reEnable")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {/* Offered on both branches: a disabled runner is exactly the one an
              operator has decided to be rid of, so hiding delete there would
              leave it undeletable from the UI. */}
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => setConfirmingHardDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("agents.lifecycle.hardDelete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmingDisable}
        onOpenChange={setConfirmingDisable}
        title={t("agents.lifecycle.disableConfirmTitle", { name })}
        description={t("agents.lifecycle.disableConfirmBody")}
        confirmLabel={t("agents.lifecycle.disableConfirmAction")}
        cancelLabel={t("agents.lifecycle.cancel")}
        pending={deactivate.isPending}
        onConfirm={() => {
          deactivate.mutate(agentId);
          setConfirmingDisable(false);
        }}
      />

      <ConfirmDialog
        open={confirmingRestart}
        onOpenChange={setConfirmingRestart}
        title={t("agents.lifecycle.restartConfirmTitle", { name })}
        description={t("agents.lifecycle.restartConfirmBody")}
        confirmLabel={t("agents.lifecycle.restartConfirmAction")}
        cancelLabel={t("agents.lifecycle.cancel")}
        // Nothing is destroyed — the runner comes back. Red would overstate it.
        destructive={false}
        pending={restart.isPending}
        onConfirm={() => {
          restart.mutate(agentId);
          setConfirmingRestart(false);
        }}
      />

      <ConfirmDialog
        open={confirmingHardDelete}
        onOpenChange={setConfirmingHardDelete}
        title={t("agents.lifecycle.hardDeleteConfirmTitle", { name })}
        description={t("agents.lifecycle.hardDeleteConfirmBody")}
        confirmLabel={t("agents.lifecycle.hardDeleteConfirmAction")}
        cancelLabel={t("agents.lifecycle.cancel")}
        requirePhrase={name}
        requirePhraseLabel={t("agents.lifecycle.hardDeleteTypeName", { name })}
        pending={hardDelete.isPending}
        onConfirm={() => {
          hardDelete.mutate(agentId);
          setConfirmingHardDelete(false);
        }}
      />
    </span>
  );
}
