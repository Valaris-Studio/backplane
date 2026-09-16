// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useRunnerConfig } from "../api/use-runner-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RunnerConfigFiles } from "@/features/agents/components/onboarding/RunnerConfigFiles";

interface RunnerConfigDialogProps {
  slug: string;
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RunnerConfigDialog({
  slug,
  boardId,
  open,
  onOpenChange,
}: RunnerConfigDialogProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useRunnerConfig(slug, boardId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("runnerConfig.title")}</DialogTitle>
          <DialogDescription>{t("runnerConfig.subtitle")}</DialogDescription>
        </DialogHeader>
        <RunnerConfigFiles data={data} isLoading={isLoading} isError={isError} onRetry={() => void refetch()} />
      </DialogContent>
    </Dialog>
  );
}
