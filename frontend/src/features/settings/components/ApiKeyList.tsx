// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Key, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { formatDate } from "@/lib/format";
import { useApiKeys, useDeleteApiKey } from "../api/use-api-keys";

export function ApiKeyList() {
  const { t } = useTranslation();
  const { data: keys, isLoading } = useApiKeys();
  const deleteKey = useDeleteApiKey();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const handleDelete = async (keyId: string) => {
    await deleteKey.mutateAsync(keyId);
    setConfirmId(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-[var(--radius-md)] bg-muted/50"
          />
        ))}
      </div>
    );
  }

  if (!keys?.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
        <Key className="h-8 w-8" />
        <p className="text-sm">{t("settings.noKeys")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {keys.map((key) => (
        <div
          key={key.id}
          className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{key.name}</p>
            <p className="text-xs text-muted-foreground">
              <RichTooltip i18nKey="settings.apiKeys.prefix" side="top">
                <code className="font-mono">{key.key_prefix}...</code>
              </RichTooltip>
              {" · "}
              {formatDate(key.created_at)}
            </p>
          </div>
          <div className="shrink-0">
            {confirmId === key.id ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-destructive">
                  {t("settings.revokeConfirm")}
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(key.id)}
                  disabled={deleteKey.isPending}
                >
                  {t("settings.revokeKey")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmId(null)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setConfirmId(key.id)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={t("a11y.settings.deleteApiKey")}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
