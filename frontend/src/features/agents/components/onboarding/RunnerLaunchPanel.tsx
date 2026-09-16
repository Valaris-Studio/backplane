// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { runnerConfigShellPath } from "../../utils/runnerConfigPath";
import { Terminal } from "lucide-react";
import { useBoards } from "@/features/kanban/api/use-boards";
import { useRunnerConfig } from "@/features/git/api/use-runner-config";
import { downloadAgentConfigBundle } from "../../utils/exportConfig";
import { RunnerConfigFiles } from "./RunnerConfigFiles";
import { GetRunnerBlock } from "./GetRunnerBlock";
import { CopyableField } from "./CopyableField";

interface RunnerLaunchPanelProps {
  slug: string;
  agentId: string;
  agentName: string;
}

// Everything an operator needs to (re)launch an EXISTING runner: pick the board
// to target, grab its config bundle, and copy the launch command. Unlike the
// creation wizard, the raw api key is never re-shown here — it was revealed once
// at creation, so the command uses the $VALARIS_API_KEY placeholder and we point
// the operator at key rotation if they lost it.
export function RunnerLaunchPanel({ slug, agentId, agentName }: RunnerLaunchPanelProps) {
  const { t } = useTranslation();
  const { data: boards, isPending: boardsPending, isError: boardsError, refetch: retryBoards } = useBoards(slug);
  const [boardId, setBoardId] = useState<string>("");
  const effectiveBoard = boardId || boards?.[0]?.id || "";
  // Scope the prerequisites to THIS runner — it already exists and was bound,
  // so the create/bind checklist items would just confuse the operator.
  const { data, isLoading, isError, refetch } = useRunnerConfig(
    slug,
    effectiveBoard,
    !!effectiveBoard,
    agentId,
  );

  const command = `VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner -config ${runnerConfigShellPath(agentName)}`;
  // The bare binary drops into the TUI setup wizard, which prompts for its own
  // credentials — it only auto-discovers `runner.yaml`, never the export
  // bundle's `runner-<name>.yaml`, so the two paths must not be conflated.
  const interactiveCommand = "./backplane-runner";

  return (
    <div className="space-y-4">
      {boards && boards.length > 1 ? (
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t("runner.launchPanel.boardPicker")}
          </label>
          <select
            className="w-full rounded-md border border-border/70 bg-card px-2 py-1.5 text-sm"
            value={effectiveBoard}
            onChange={(e) => setBoardId(e.target.value)}
            data-testid="launch-board-picker"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <GetRunnerBlock />

      {boardsPending ? (
        <p role="status" data-testid="launch-boards-pending">{t("common.loading")}</p>
      ) : boardsError ? (
        <div role="alert" className="space-y-2" data-testid="launch-boards-error">
          <p className="text-sm text-destructive">{t("runner.launchWizard.boardsError")}</p>
          <Button variant="outline" onClick={() => void retryBoards()}>{t("runners.retry")}</Button>
        </div>
      ) : !boards?.length ? (
        <p className="text-sm text-muted-foreground" data-testid="launch-boards-empty">
          {t("runner.launchWizard.boardsEmpty")}
        </p>
      ) : (
        <RunnerConfigFiles
          data={data}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => void refetch()}
          onDownloadAgentConfig={() => downloadAgentConfigBundle(agentId, agentName)}
        />
      )}

      <div
        className="rounded-lg border border-border/60 bg-muted/20 p-4"
        data-testid="launch-interactive-block"
      >
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {t("runner.launchWizard.launchInteractive")}
        </p>
        <CopyableField value={interactiveCommand} testid="launch-command-interactive" mono />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.launchInteractiveHint")}
        </p>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {t("runner.launchWizard.launchCommand")}
        </p>
        <CopyableField value={command} testid="launch-command" mono />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.launchCommandHint")}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">{t("runner.launchPanel.apiKeyNote")}</p>
    </div>
  );
}
