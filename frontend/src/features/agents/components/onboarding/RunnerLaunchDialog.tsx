// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Rocket } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RunnerLaunchPanel } from "./RunnerLaunchPanel";

interface RunnerLaunchDialogProps {
  slug: string;
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Modal wrapper around RunnerLaunchPanel — the "launch THIS runner" surface
// reached from the pipeline canvas's per-lane rocket. Distinct from the create
// wizard: no identity/bind steps, the runner already exists.
export function RunnerLaunchDialog({
  slug,
  agentId,
  agentName,
  open,
  onOpenChange,
}: RunnerLaunchDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" />
            {t("runner.launchPanel.dialogTitle", { name: agentName })}
          </DialogTitle>
        </DialogHeader>
        <RunnerLaunchPanel slug={slug} agentId={agentId} agentName={agentName} />
      </DialogContent>
    </Dialog>
  );
}
