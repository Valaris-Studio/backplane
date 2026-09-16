// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";

// An inline MCP tool name the user can hand straight to their agent. Unlike
// CopyableBlock this is a single identifier, so it reads as prose-adjacent code
// rather than a chrome-barred snippet. The accessible name carries the tool so
// several of these in one pane stay distinguishable in a button list.
export function CopyableToolName({ tool }: { tool: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    if (!(await copyTextToClipboard(tool))) return;
    setCopied(true);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-1.5">
      <code className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)] px-1.5 py-0.5 font-mono text-[0.78rem] font-medium text-foreground">
        {tool}
      </code>
      <Button
        variant="ghost"
        size="icon"
        onClick={copy}
        className="h-6 w-6 shrink-0"
        aria-label={`${t("a11y.mcpOnboarding.copyToolName")}: ${tool}`}
      >
        {copied ? (
          <Check className="h-3 w-3 text-success motion-safe:animate-pop-in" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}
