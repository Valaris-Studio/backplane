// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Turning a raw prompt into a slotted kernel: the offset math behind
// "Save as template…" (card 41bf51d3, spec f52328b3 §3.2).
//
// Kept pure and free of React so the marking view can stay a dumb read-only
// `<pre>`: the sheet maps a DOM selection to string offsets once, then every
// mutation below is plain text-in / text-out. That split is what makes the
// behaviour testable — jsdom's getSelection is too partial to drive the real
// thing.

import type { SlotKind } from "./slot-catalog";

/**
 * The five Go-template variables the runner substitutes itself.
 *
 * They are a FIXED contract with `runner/internal/workloop` — Workspace,
 * BoardID, AgentID, ExecutionID, Iteration — and must survive templating
 * untouched, so the sheet surfaces them as preserved rather than offering
 * them as slot candidates.
 */
export const RUNNER_VAR_PATTERN =
  /\{\{\.(Workspace|BoardID|AgentID|ExecutionID|Iteration)\}\}/g;

export interface TextRange {
  start: number;
  end: number;
}

/** The `<<NAME>>` token that replaces a marked range. */
export function slotToken(name: string): string {
  return `<<${name}>>`;
}

function isUsableRange(text: string, start: number, end: number): boolean {
  return start >= 0 && end <= text.length && start < end;
}

/**
 * Replace one marked range with its slot token.
 *
 * A collapsed, inverted or out-of-bounds range is returned unchanged rather
 * than throwing: the caller is a mouse selection, and a stray click is a
 * no-op, not an error.
 */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  name: string,
): string {
  if (!isUsableRange(text, start, end)) return text;
  return text.slice(0, start) + slotToken(name) + text.slice(end);
}

export interface ReplaceAllResult {
  text: string;
  count: number;
}

/**
 * Replace every literal occurrence of `needle`.
 *
 * `split`/`join` rather than a RegExp because the needle is arbitrary prompt
 * text: `a.c`, `$1` and `(x)` all appear in real kernels and would otherwise
 * be interpreted as a pattern or a replacement reference. It also cannot loop
 * when the replacement contains the needle.
 */
export function replaceAll(
  text: string,
  needle: string,
  name: string,
): ReplaceAllResult {
  if (!needle) return { text, count: 0 };
  const parts = text.split(needle);
  return { text: parts.join(slotToken(name)), count: parts.length - 1 };
}

/** Literal (non-regex) occurrence count — drives the "replace all N" offer. */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/**
 * Operator direction 2026-08-16: a range spanning lines is a block, a range
 * within one line is a scalar. The author can override in the review step.
 */
export function deriveKind(selected: string): SlotKind {
  return selected.includes("\n") ? "block" : "scalar";
}

/**
 * Recover character offsets for a leak-lint finding.
 *
 * The backend `Finding` (app/services/loop_template_lint.py) carries `match`
 * and a 1-based `line` but no offset, so the "make slot" shortcut has to find
 * the text itself. Anchoring on the reported line matters: a repo URL or an
 * org/repo pair typically appears several times, and jumping to the first hit
 * would pre-select the wrong one. Falls back to the first occurrence when the
 * line lookup misses, so a stale line number degrades instead of dead-ending.
 */
export function findMatchRange(
  text: string,
  match: string,
  line: number,
): TextRange | null {
  if (!match) return null;

  const lines = text.split("\n");
  const target =
    line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
  if (target !== undefined) {
    const column = target.indexOf(match);
    if (column !== -1) {
      // +1 per preceding line for the newline split() removed.
      const lineStart = lines
        .slice(0, line - 1)
        .reduce((total, each) => total + each.length + 1, 0);
      return {
        start: lineStart + column,
        end: lineStart + column + match.length,
      };
    }
  }

  const fallback = text.indexOf(match);
  return fallback === -1
    ? null
    : { start: fallback, end: fallback + match.length };
}
