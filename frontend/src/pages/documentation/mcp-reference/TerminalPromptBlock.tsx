// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CopyButton } from "./CopyButton";
import { useDocumentationCopy } from "../use-documentation-copy";

export function TerminalPromptBlock({ prompt }: { prompt: string }) {
  const { copy } = useDocumentationCopy();
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-surface-2)] shadow-soft">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-red-400/80" />
          <span className="h-2 w-2 rounded-full bg-amber-400/80" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
        </div>
        <CopyButton
          text={prompt}
          label={copy.mcpReference.copyExamplePrompt}
        />
      </div>
      <pre className="whitespace-pre-wrap bg-[color:var(--color-muted)] px-4 py-3 font-mono text-[0.82rem] leading-[1.55] text-foreground">
        <code>{prompt}</code>
      </pre>
    </div>
  );
}
