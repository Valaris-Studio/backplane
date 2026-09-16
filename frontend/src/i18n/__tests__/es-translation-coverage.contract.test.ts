// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";

/**
 * Untranslated-value contract for the es catalog (card 7b3de1b8).
 *
 * A Spanish value byte-identical to its English source is either untranslated
 * copy that shipped as English, or a term that is legitimately identical in
 * Spanish (cognate, proper noun, product vocabulary the es catalog keeps in
 * English by design — "Runner", "pipeline", "prompt", per the deliberate
 * denylist rationale in es-orthography.test.ts). This contract makes that
 * distinction explicit and mechanical:
 *
 *  - structurally inert values (code tokens, enum values, paths, templates,
 *    interpolation-only strings) are skipped — they are semantic identifiers,
 *    not copy;
 *  - every remaining identical value must appear in one of the two literal
 *    allowlists below, each entry justified;
 *  - anything else fails, enumerated key by key.
 *
 * The comparison is exact equality only — near-identical values are a human
 * judgment, not a contract.
 */

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function collectStrings(
  value: JsonValue,
  path = "",
  result = new Map<string, string>(),
) {
  if (typeof value === "string") {
    result.set(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStrings(item, `${path}[${index}]`, result),
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, path === "" ? key : `${path}.${key}`, result);
    }
  }
  return result;
}

const stripPlaceholders = (value: string) =>
  value.replace(/\{\{[^{}]+\}\}|<<[^>]+>>/g, "");

/**
 * Values that are identifiers rather than copy: translating them would break
 * config examples, enum wiring or docs paths, so identity carries no signal.
 */
function isStructurallyInert(value: string) {
  const letters = stripPlaceholders(value).match(/[A-Za-z]/g) ?? [];
  if (letters.length <= 1) return true; // symbols, numbers, "v{{version}}"
  if (/^\(?[a-z][a-z0-9]*\)?$/.test(value)) return true; // enum/code token
  if (/^[A-Z0-9]{2,4}$/.test(value)) return true; // short acronym (OK, URL, TTL)
  if (/^(<<)?[A-Z0-9]+(_[A-Z0-9]+)+(>>)?$/.test(value)) return true; // CONSTANT_CASE
  if (/[_/`\n"<=@]|https?:/.test(value)) return true; // code, paths, URLs
  // Hyphenated identifiers and comma-separated enum lists. The comma-or-
  // hyphen requirement is what keeps plain lowercase English prose ("no
  // results found") OUT of this rule.
  if (/^[a-z0-9().,\s-]+$/.test(value) && /[,-]/.test(value)) return true;
  if (/^[<>≥≤+-]?\s?\d/.test(value)) return true; // numeric-leading
  return false;
}

/**
 * Exact values that are legitimately identical in Spanish wherever they
 * appear. Grouped by justification; keep each entry commented.
 */
const IDENTICAL_BY_DESIGN_VALUES = new Set([
  // Product / proper nouns.
  "Runner",
  "Runners",
  "Backplane",
  "Valaris MCP",
  "Git",
  "GitHub",
  "GitLab",
  "Bitbucket",
  "Gitea",
  "OAuth",
  "Kanban",
  // Product vocabulary the es catalog keeps in English by design (the es
  // prose already uses these as loanwords: "el pipeline", "el prompt",
  // "el loop", "el slot", "valores de slots").
  "Pipeline",
  "Prompt",
  "Prompts",
  "prompt: {{slug}}",
  "prompts: {{slugs}}",
  "Slots",
  "{{count}} slot.",
  "{{count}} slots.",
  "Slots: {{before}} → {{after}}",
  "Loops",
  "Backlog", // columns.type.backlog is deliberately "Backlog" in es
  "Slug",
  "Token",
  "Tokens",
  "Tokens (7d)",
  "Tokens (30d)",
  "Preset",
  "SKILL.md", // literal filename
  // Technical terms Spanish keeps in English: "pull request" appears
  // untranslated in the es prose of this catalog, and "round robin" is the
  // standard untranslated scheduling term in Spanish technical writing.
  "Pull request",
  "Round robin",
  "{{bytes}} bytes", // byte is also the Spanish unit name

  // Cognates — the Spanish word is spelled identically.
  "Alias",
  "Alias (as)",
  "Editor",
  "Emoji",
  "Inspector",
  "No",
  "Personal",
  "Plan",
  "Roles",
  "v{{version}} · {{count}} roles",
  "Sensor",
  "Terminal",
  // Abbreviations that read the same in both languages.
  "Docs", // Documentación / Documentation
  "Deps", // Dependencias / Dependencies
  "Op", // Operador / Operator
]);

/**
 * Keys whose value is a literal artifact — quoted config payloads or the
 * exact English section headings loop templates emit — so the es tooltip
 * must show them verbatim.
 */
const IDENTICAL_BY_DESIGN_KEYS = new Set([
  // Card-section headings are contract strings templates write into cards.
  "ui.tooltips.loopTemplates.contract.card_sections.examples[0]",
  "ui.tooltips.loopTemplates.contract.card_sections.examples[1]",
  "ui.tooltips.loopTemplates.contract.card_sections.examples[2]",
  // Literal approval-request payload values.
  "ui.tooltips.approvals.category.deployment.rows[1].value",
  "ui.tooltips.approvals.category.deployment.rows[2].value",
  // Literal payload value plus SQL operation names.
  "ui.tooltips.approvals.category.schema_change.rows[1].value",
]);

describe("es translation coverage contract", () => {
  const englishStrings = collectStrings(en as JsonValue);
  const spanishStrings = collectStrings(es as JsonValue);

  it("keeps no untranslated English value outside the allowlists", () => {
    const untranslated: string[] = [];

    for (const [path, spanishValue] of spanishStrings) {
      const englishValue = englishStrings.get(path);
      if (englishValue === undefined || englishValue !== spanishValue) continue;
      if (isStructurallyInert(spanishValue)) continue;
      if (IDENTICAL_BY_DESIGN_VALUES.has(spanishValue)) continue;
      if (IDENTICAL_BY_DESIGN_KEYS.has(path)) continue;
      untranslated.push(`${path} = ${JSON.stringify(spanishValue)}`);
    }

    expect(untranslated, "es values identical to en").toEqual([]);
  });

  it("carries no stale allowlist entries", () => {
    const identicalValues = new Set<string>();
    const identicalKeys = new Set<string>();
    for (const [path, spanishValue] of spanishStrings) {
      if (englishStrings.get(path) === spanishValue) {
        identicalValues.add(spanishValue);
        identicalKeys.add(path);
      }
    }

    const staleValues = [...IDENTICAL_BY_DESIGN_VALUES].filter(
      (value) => !identicalValues.has(value),
    );
    const staleKeys = [...IDENTICAL_BY_DESIGN_KEYS].filter(
      (key) => !identicalKeys.has(key),
    );

    expect(staleValues, "allowlisted values no longer identical").toEqual([]);
    expect(staleKeys, "allowlisted keys no longer identical").toEqual([]);
  });
});
