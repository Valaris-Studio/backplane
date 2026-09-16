// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// A read-only value with a copy-to-clipboard affordance. Shared by the launch
// wizard (create flow) and RunnerLaunchPanel (existing-runner flow) so the
// api-key / launch-command surface is identical wherever a runner is launched.
export function CopyableField({
  label,
  value,
  testid,
  mono,
}: {
  label?: string;
  value: string;
  testid?: string;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const copiedSuccessfully = await copyTextToClipboard(value);
    if (!copiedSuccessfully) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div>
      {label ? (
        <label className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      ) : null}
      <div className="flex items-center gap-2">
        <code
          className={cn(
            "flex-1 overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs",
            mono && "font-mono",
          )}
          data-testid={testid}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="icon"
          onClick={copy}
          className="h-9 w-9 flex-shrink-0"
          aria-label={t("common.copy")}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[color:var(--color-success-foreground)] motion-safe:animate-pop-in" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
