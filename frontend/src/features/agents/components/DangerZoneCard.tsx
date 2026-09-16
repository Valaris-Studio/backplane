// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Download, KeyRound } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import { useRotateAgentKey } from "../hooks/useAgentMetrics";
import { downloadAgentConfigBundle } from "../utils/exportConfig";
import type { AgentCreated } from "../api/agents";

interface DangerZoneCardProps {
  slug: string;
  agentId: string;
  agentName: string;
  lastKeyRotatedAt: string | null;
}

type DialogPhase = "confirm" | "success";

export function DangerZoneCard({
  slug,
  agentId,
  agentName,
  lastKeyRotatedAt,
}: DangerZoneCardProps) {
  const { t } = useTranslation();
  const rotate = useRotateAgentKey(slug);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>("confirm");
  const [rotated, setRotated] = useState<AgentCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const resetDialog = () => {
    setOpen(false);
    setPhase("confirm");
    setRotated(null);
    setCopied(false);
  };

  const handleConfirm = () => {
    rotate.mutate(agentId, {
      onSuccess: (agent) => {
        setRotated(agent);
        setPhase("success");
        toast.success(t("agents.rotateApiKeySuccess"));
      },
      onError: () => toast.error(t("common.loadError")),
    });
  };

  const handleCopy = async () => {
    if (!rotated?.raw_api_key) return;
    const copiedSuccessfully = await copyTextToClipboard(rotated.raw_api_key);
    if (!copiedSuccessfully) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadBundle = async () => {
    try {
      await downloadAgentConfigBundle(agentId, agentName);
    } catch {
      toast.error(t("agents.configSaveError"));
    }
  };

  const rotatedLabel = lastKeyRotatedAt
    ? t("agents.lastRotatedAt", {
        when: formatDateTime(lastKeyRotatedAt),
      })
    : t("agents.neverRotated");

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle
          role="heading"
          aria-level={3}
          className="flex items-center gap-2 text-lg text-destructive"
        >
          <AlertTriangle className="h-4 w-4" />
          {t("agents.dangerZone")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {t("agents.rotateApiKey")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("agents.rotateApiKeyDescription")}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {rotatedLabel}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setOpen(true)}
            className="sm:shrink-0"
          >
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            {t("agents.rotateApiKey")}
          </Button>
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : resetDialog())}>
        <DialogContent>
          {phase === "confirm" ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("agents.rotateApiKey")}</DialogTitle>
                <DialogDescription>
                  {t("agents.rotateApiKeyConfirm")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={resetDialog}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleConfirm}
                  disabled={rotate.isPending}
                >
                  {rotate.isPending ? t("common.saving") : t("agents.rotateApiKey")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("agents.rotateApiKey")}</DialogTitle>
                <DialogDescription>
                  {t("agents.apiKeyWarning")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    {t("agents.apiKey")}
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs">
                      {rotated?.raw_api_key}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopy}
                      className="h-9 w-9 flex-shrink-0"
                      aria-label={t("a11y.agents.copyToken")}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-[color:var(--color-success-foreground)]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadBundle}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t("agents.downloadNewBundle")}
                </Button>
              </div>

              <DialogFooter>
                <Button onClick={resetDialog}>{t("common.done")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
