// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";

export type PromptTokenKind =
  "slot" | "unknown-slot" | "runner" | "unknown-runner";

// Mirrors the backend grammar in app/services/loop_config_validation.py:
//   SLOT_PATTERN       = <<[A-Z][A-Z0-9_]*>>
//   RUNNER_VAR_PATTERN = \{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)
// The runner half additionally consumes the trailing `}}` here — the backend
// only needs the NAME, the highlighter needs the whole span to paint it. The
// uppercase-only slot rule is what keeps `cat <<EOF` and `2>>log` unpainted.
const TOKEN_PATTERN =
  /<<[A-Z][A-Z0-9_]*>>|\{\{-?\s*\.[A-Za-z_][A-Za-z0-9_]*\s*-?\}\}/g;

const SLOT_NAME = /^<<([A-Z][A-Z0-9_]*)>>$/;
const RUNNER_NAME = /^\{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*-?\}\}$/;

const KIND_CLASS: Record<PromptTokenKind, string> = {
  runner: "bg-primary/15 text-primary",
  slot: "bg-muted text-foreground",
  "unknown-slot": "bg-destructive/15 text-destructive",
  "unknown-runner": "bg-destructive/15 text-destructive",
};

type Segment = { text: string; kind: PromptTokenKind | null };

function classify(
  token: string,
  slots: ReadonlySet<string>,
  runnerVars: ReadonlySet<string>,
): PromptTokenKind {
  const slot = SLOT_NAME.exec(token)?.[1];
  if (slot !== undefined) return slots.has(slot) ? "slot" : "unknown-slot";
  const runner = RUNNER_NAME.exec(token)?.[1];
  return runner !== undefined && runnerVars.has(runner)
    ? "runner"
    : "unknown-runner";
}

function tokenize(
  text: string,
  slots: ReadonlySet<string>,
  runnerVars: ReadonlySet<string>,
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const at = match.index;
    if (at > cursor)
      segments.push({ text: text.slice(cursor, at), kind: null });
    segments.push({
      text: match[0],
      kind: classify(match[0], slots, runnerVars),
    });
    cursor = at + match[0].length;
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), kind: null });
  return segments;
}

/**
 * Read-only rendering of a prompt with its slots and runner variables painted.
 *
 * Deliberately a separate pane rather than in-textarea highlighting: no editor
 * dependency, and the operator keeps a plain textarea to type into.
 *
 * An omitted `slots` catalog means "nothing is known", so every `<<X>>` shows
 * as unknown — the honest reading when the caller has no catalog to check.
 */
export function PromptHighlightPreview({
  text,
  slots,
  runnerVars,
  className,
}: {
  text: string;
  slots?: readonly string[];
  runnerVars: readonly string[];
  className?: string;
}) {
  const slotSet = new Set(slots ?? []);
  const runnerSet = new Set(runnerVars);

  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border/70 bg-surface-1/40 p-3 font-mono text-xs text-foreground",
        className,
      )}
    >
      {tokenize(text, slotSet, runnerSet).map((segment, i) =>
        segment.kind ? (
          <mark
            key={i}
            data-kind={segment.kind}
            className={cn("rounded-[3px] px-0.5", KIND_CLASS[segment.kind])}
          >
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </pre>
  );
}
