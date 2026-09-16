// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Same copy contract as callouts/CodeExample: clipboard write + sonner toast +
// Check/Copy icon swap. Extracted so every copy affordance in the reference
// behaves identically.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useDocumentationCopy } from "../use-documentation-copy";

const COPY_CONFIRMATION_MS = 1400;

interface CopyButtonProps {
  text: string;
  label: string;
  className?: string;
}

export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { copy } = useDocumentationCopy();

  async function handleCopy() {
    const copiedSuccessfully = await copyTextToClipboard(text);
    if (!copiedSuccessfully) return;
    setCopied(true);
    toast.success(copy.shell.copiedToast);
    window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-surface-1)] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
        "hover:bg-[color:var(--color-accent)] hover:text-accent-foreground",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}
