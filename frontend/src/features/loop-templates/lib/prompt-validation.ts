// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Client-side mirror of the backend publish validator, for live authoring
// feedback. Direction (card 199bf1ec): these chips MIRROR the server rules and
// never replace them — Publish still surfaces the server's 422 field paths.
//
// Grammar is shared with PromptHighlightPreview and the backend
// (app/services/loop_config_validation.py):
//   SLOT_PATTERN       = <<[A-Z][A-Z0-9_]*>>
//   RUNNER_VAR_PATTERN = \{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)
const SLOT_TOKEN = /<<([A-Z][A-Z0-9_]*)>>/g;
const RUNNER_TOKEN = /\{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*-?\}\}/g;

export type PromptIssue =
  | { kind: "unknown-slot"; name: string }
  | { kind: "unused-slot"; name: string }
  | { kind: "non-runner-var"; name: string };

/** Every `<<NAME>>` referenced across the given prompt texts. */
export function referencedSlots(texts: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SLOT_TOKEN)) {
      const name = match[1];
      if (name) found.add(name);
    }
  }
  return found;
}

/** Every `{{.Name}}` referenced across the given prompt texts. */
export function referencedRunnerVars(texts: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(RUNNER_TOKEN)) {
      const name = match[1];
      if (name) found.add(name);
    }
  }
  return found;
}

/**
 * The publish-blocking problems visible from the prompts alone.
 *
 * A slot counts as USED when either prompt references it *or* a variant fill
 * does: a slot whose only job is to feed another slot's variant text is not
 * dead, and flagging it would train authors to ignore the chip.
 */
export function validatePrompts({
  systemPrompt,
  loopPrompt,
  slotNames,
  variantFills = [],
  runnerVars,
}: {
  systemPrompt: string;
  loopPrompt: string;
  slotNames: readonly string[];
  variantFills?: readonly string[];
  runnerVars: readonly string[];
}): PromptIssue[] {
  const prompts = [systemPrompt, loopPrompt];
  const catalog = new Set(slotNames);
  const runnerSet = new Set(runnerVars);

  const issues: PromptIssue[] = [];

  const inPrompts = referencedSlots(prompts);
  for (const name of inPrompts) {
    if (!catalog.has(name)) issues.push({ kind: "unknown-slot", name });
  }

  const usedAnywhere = referencedSlots([...prompts, ...variantFills]);
  for (const name of slotNames) {
    if (!usedAnywhere.has(name)) issues.push({ kind: "unused-slot", name });
  }

  for (const name of referencedRunnerVars(prompts)) {
    if (!runnerSet.has(name)) issues.push({ kind: "non-runner-var", name });
  }

  return issues;
}

/** Splice `token` into `text` at the caret, returning the new text + caret. */
export function insertAtCaret(
  text: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; caret: number } {
  const before = text.slice(0, selectionStart);
  const after = text.slice(selectionEnd);
  return {
    text: `${before}${token}${after}`,
    caret: selectionStart + token.length,
  };
}
