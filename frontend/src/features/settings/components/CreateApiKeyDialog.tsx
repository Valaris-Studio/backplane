// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Check, Copy, AlertTriangle } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCreateApiKey } from "../api/use-api-keys";

interface CreateApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
}: CreateApiKeyDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createKey = useCreateApiKey();

  const handleCreate = async () => {
    if (!name.trim()) return;
    const result = await createKey.mutateAsync({ name: name.trim() });
    setRawKey(result.raw_key);
  };

  const handleCopy = async () => {
    if (!rawKey) return;
    const copiedSuccessfully = await copyTextToClipboard(rawKey);
    if (!copiedSuccessfully) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setRawKey(null);
      setCopied(false);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {rawKey ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.keyCreatedTitle")}</DialogTitle>
              <DialogDescription className="flex items-start gap-2 pt-1">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                {t("settings.keyCreatedWarning")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-[var(--radius-sm)] border border-border/70 bg-[color:var(--color-surface-1)] px-3 py-2.5 font-mono text-xs select-all">
                  {rawKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  className="shrink-0"
                  aria-label={t("a11y.settings.copyApiKey")}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.generateKey")}</DialogTitle>
              <DialogDescription>
                {t("settings.apiKeysDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <label className="text-sm font-medium">
                {t("settings.keyNameLabel")}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("settings.keyNamePlaceholder")}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!name.trim() || createKey.isPending}
              >
                {createKey.isPending
                  ? t("common.creating")
                  : t("settings.generateKey")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
