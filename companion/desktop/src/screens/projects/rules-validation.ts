// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Client-side limits, tighter than the server's (512 characters, 128 rules).
export const MAX_RULE_LENGTH = 256;
export const MAX_RULES = 50;

export type RuleCheck = { ok: true; rule: string } | { ok: false; message: string };

export function validateNewRule(typed: string, current: readonly string[]): RuleCheck {
  if (/[\r\n]/.test(typed)) return { ok: false, message: "Keep the pattern on one line." };
  const rule = typed.trim();
  if (rule === "") return { ok: false, message: "Type a folder pattern, like ~/clients/**." };
  if (rule.length > MAX_RULE_LENGTH) return { ok: false, message: `Keep the pattern to ${MAX_RULE_LENGTH} characters or fewer.` };
  if (current.includes(rule)) return { ok: false, message: "That rule is already in the list." };
  if (current.length >= MAX_RULES) return { ok: false, message: `You can have up to ${MAX_RULES} rules. Remove one first.` };
  return { ok: true, rule };
}
