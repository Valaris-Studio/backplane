// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reuse the documentation design tokens without adding a second syntax
// highlighting dependency. A dedicated highlighter remains an explicit future
// enhancement.

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { scaleIn } from "@/lib/animations";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useDocumentationCopy } from "../use-documentation-copy";

interface CodeExampleProps {
  title?: string;
  language: string;
  children: string;
  className?: string;
}

const COPY_CONFIRMATION_MS = 1400;

export function CodeExample({
  title,
  language,
  children,
  className,
}: CodeExampleProps) {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const { copy } = useDocumentationCopy();

  useEffect(() => {
    if (reducedMotion || !containerRef.current) return;
    scaleIn(containerRef.current, { duration: 0.2, offset: 0 });
  }, [reducedMotion]);

  async function handleCopy() {
    const copiedSuccessfully = await copyTextToClipboard(children);
    if (!copiedSuccessfully) return;
    setCopied(true);
    toast.success(copy.shell.copiedToast);
    window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS);
  }

  return (
    <figure
      ref={containerRef}
      data-stagger-item
      className={cn(
        "my-5 overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-surface-2)] shadow-soft",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-doc-technical
            className="rounded-full border border-border/70 bg-[color:var(--color-surface-1)] px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            {language}
          </span>
          {title ? (
            <figcaption className="truncate text-xs font-medium text-foreground/85">
              {title}
            </figcaption>
          ) : null}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copy.shell.copyCode}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-[color:var(--color-surface-1)] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
            "hover:bg-[color:var(--color-accent)] hover:text-accent-foreground",
          )}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden />
              {copy.shell.copiedCode}
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {copy.shell.copyCode}
            </>
          )}
        </button>
      </header>
      <pre className="overflow-x-auto bg-[color:var(--color-muted)] px-4 py-3 text-[0.82rem] leading-[1.55] text-foreground">
        <code data-language={language} className="font-mono">
          {children}
        </code>
      </pre>
    </figure>
  );
}
