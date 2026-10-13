// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";

const COPIED_FEEDBACK_MS = 2000;

/**
 * A terminal command inside a sentence: monospace, with a copy button right after it.
 * `punctuation` ends the sentence inside the chip's no-wrap unit, so it never starts a line alone.
 */
export function CommandChip({ command, punctuation }: { command: string; punctuation?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">("idle");
  const codeRef = useRef<HTMLElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const copy = async () => {
    clearTimeout(copiedTimer.current);
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      copiedTimer.current = setTimeout(() => setCopyState("idle"), COPIED_FEEDBACK_MS);
    } catch {
      // The webview can refuse clipboard writes; leave the command selected for a copy shortcut instead.
      const code = codeRef.current;
      if (code) window.getSelection()?.selectAllChildren(code);
      setCopyState("blocked");
    }
  };

  return (
    <span className="bp-command" data-copied={copyState === "copied"}>
      <code ref={codeRef}>{command}</code>
      <button type="button" className="bp-command-copy" aria-label="Copy command" onClick={() => void copy()}>
        <Icon name={copyState === "copied" ? "check" : "copy"} />
      </button>
      {punctuation}
      {/* Always mounted, so the polite announcement is heard when its text changes. */}
      <span role="status" aria-live="polite" className="bp-command-status">
        {copyState === "copied" ? "Copied" : copyState === "blocked" ? `Couldn’t copy. Type ${command} in a terminal instead.` : null}
      </span>
    </span>
  );
}
