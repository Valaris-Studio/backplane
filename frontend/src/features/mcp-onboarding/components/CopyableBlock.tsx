// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// The TerminalPromptBlock look (chrome bar + copy affordance + monospace body)
// for multi-line content. Unlike CopyableField, the copy button's accessible
// name is caller-supplied, because a wizard step shows several blocks and
// "Copy" alone would leave them indistinguishable in a screen reader's button
// list.
export function CopyableBlock({
  label,
  value,
  copyLabel,
  testid,
  className,
}: {
  label: string;
  value: string;
  copyLabel: string;
  testid?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    const copiedSuccessfully = await copyTextToClipboard(value);
    setCopyFailed(!copiedSuccessfully);
    setCopied(copiedSuccessfully);
    clearTimeout(resetTimer.current);
    if (!copiedSuccessfully) return;
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-surface-2)] shadow-soft",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <span className="text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={copy}
          className="h-7 w-7 shrink-0"
          aria-label={copyLabel}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success motion-safe:animate-pop-in" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {copyFailed ? <p role="alert" className="px-3 py-2 text-sm text-destructive">{t("mcpOnboarding.copyFailed")}</p> : null}
      <pre
        tabIndex={0}
        data-testid={testid}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-[color:var(--color-muted)] px-4 py-3 font-mono text-[0.78rem] leading-[1.6] text-foreground"
      >
        {value}
      </pre>
    </div>
  );
}
