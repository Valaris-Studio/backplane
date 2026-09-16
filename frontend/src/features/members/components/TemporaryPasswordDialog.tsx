// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { useSetTemporaryPassword } from "../api/use-members";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WorkspaceMember } from "@/types/member";

interface TemporaryPasswordDialogProps {
  slug: string;
  member: WorkspaceMember | null;
  onOpenChange: (open: boolean) => void;
}

// The L6 recovery path: no reset emails exist, so an admin generates a
// temporary password here and hands it over out of band. Shown exactly once.
export function TemporaryPasswordDialog({
  slug,
  member,
  onOpenChange,
}: TemporaryPasswordDialogProps) {
  const { t } = useTranslation();
  const setTemporaryPassword = useSetTemporaryPassword(slug);
  const [copied, setCopied] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setTemporaryPassword.reset();
      setCopied(false);
    }
    onOpenChange(open);
  };

  const secret = setTemporaryPassword.data?.temporary_password;

  return (
    <Dialog open={!!member} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("members.tempPasswordTitle")}</DialogTitle>
          <DialogDescription>
            {t("members.tempPasswordDescription", {
              name: member?.name || member?.email,
            })}
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("members.tempPasswordShownOnce")}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-border/70 bg-muted px-3 py-2 font-mono text-sm">
                {secret}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("common.copy")}
                onClick={async () => {
                  const copiedSuccessfully = await copyTextToClipboard(secret);
                  if (copiedSuccessfully) setCopied(true);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        ) : (
          setTemporaryPassword.isError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t("members.tempPasswordFailed")}
            </p>
          )
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {secret ? t("common.close") : t("common.cancel")}
          </Button>
          {!secret && (
            <Button
              type="button"
              disabled={setTemporaryPassword.isPending || !member}
              onClick={() => {
                if (member) setTemporaryPassword.mutate(member.user_id);
              }}
            >
              {t("members.tempPasswordGenerate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
