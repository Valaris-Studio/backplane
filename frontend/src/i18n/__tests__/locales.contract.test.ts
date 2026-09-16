// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInstance, type ResourceLanguage } from "i18next";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBr from "../locales/pt-BR.json";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type LocaleCode = keyof typeof catalogs;

const catalogs = {
  en: en as JsonValue,
  es: es as JsonValue,
  "pt-BR": ptBr as JsonValue,
};

const pluralSuffixPattern = /_(zero|one|two|few|many|other)$/;
const legacyPluralSuffixPattern = /_plural$/;
const interpolationPattern = /\{\{[^{}]+\}\}/g;
const quotedSimpleValuePattern = /(["'])([a-z][a-z0-9_-]*)\1/g;

// Matches inline code, template expressions, URLs, and identifier-like tokens.
const technicalTokenPattern =
  /`[^`]+`|\$\{[^{}]+\}|https?:\/\/[^\s)]+|<[a-z][a-z0-9_-]*>|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b|(?<![\p{L}\p{N}_@])--?[a-z][a-z0-9-]*\b|\b[a-z][a-z0-9/-]*(?:[._][a-z0-9_/-]+)+\b/gu;

const protectedQuotedCodeValues = new Set([
  "active",
  "approve",
  "backlog",
  "blocked",
  "bug",
  "ci",
  "column_scan",
  "documentator",
  "done",
  "end",
  "feature",
  "helper",
  "hero",
  "issue",
  "lint",
  "llm",
  "merge",
  "planned",
  "produces_decision",
  "request_changes",
  "review",
  "reviewer",
  "rework",
  "stakeholder",
  "task",
  "unassigned_or_rework",
  "viewer",
]);

const translatableCodeValueFields = new Set([
  "description",
  "label",
  "message",
  "name",
  "prompt",
  "summary",
  "text",
  "title",
]);

const legacyPluralStems = [
  "pipeline.lifecycle.role.stepsCount",
  "pipeline.lifecycle.role.llmStepCount",
] as const;

function valueType(value: JsonValue) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function collectShape(
  value: JsonValue,
  path = "<root>",
  result = new Map<string, string>(),
) {
  const logicalPath = path
    .replace(pluralSuffixPattern, "_<plural>")
    .replace(legacyPluralSuffixPattern, "_<plural>");
  const type = valueType(value);
  const previousType = result.get(logicalPath);

  if (previousType !== undefined && previousType !== type) {
    result.set(logicalPath, `${previousType}|${type}`);
  } else {
    result.set(logicalPath, type);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectShape(item, `${path}[${index}]`, result));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectShape(child, path === "<root>" ? key : `${path}.${key}`, result);
    }
  }

  return result;
}

function collectStrings(
  value: JsonValue,
  path = "<root>",
  result = new Map<string, string>(),
) {
  if (typeof value === "string") {
    result.set(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, result));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, path === "<root>" ? key : `${path}.${key}`, result);
    }
  }

  return result;
}

function collectPaths(
  value: JsonValue,
  path = "<root>",
  result: string[] = [],
) {
  result.push(path);

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPaths(item, `${path}[${index}]`, result));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, path === "<root>" ? key : `${path}.${key}`, result);
    }
  }

  return result;
}

function placeholders(value: string) {
  return [...value.matchAll(interpolationPattern)].map(([token]) => token).sort();
}

function technicalTokens(value: string) {
  return [...value.matchAll(technicalTokenPattern)]
    .map(([token]) =>
      token.startsWith("`") && token.endsWith("`") ? token.slice(1, -1) : token,
    )
    .filter((token) => !["e.g", "i.e"].includes(token.toLowerCase()))
    .sort();
}

function quotedCodeValues(value: string) {
  const values: string[] = [];

  for (const match of value.matchAll(quotedSimpleValuePattern)) {
    const token = match[2];
    if (token === undefined) continue;

    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    const isObjectKey = /^\s*:/.test(value.slice(matchEnd));
    const assignedField = value
      .slice(0, matchStart)
      .match(/["']([a-z][a-z0-9_-]*)["']\s*:\s*$/)?.[1];
    const isTranslatableField =
      assignedField !== undefined &&
      translatableCodeValueFields.has(assignedField);

    if (
      !isObjectKey &&
      !isTranslatableField &&
      protectedQuotedCodeValues.has(token)
    ) {
      values.push(token);
    }
  }

  return values.sort();
}

function protectedCodeValueMismatch(
  path: string,
  englishValue: string,
  localizedValue: string,
) {
  const expected = quotedCodeValues(englishValue);
  const actual = quotedCodeValues(localizedValue);

  if (JSON.stringify(actual) === JSON.stringify(expected)) return undefined;

  return `${path}: expected protected code values ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

function englishTemplateFor(
  path: string,
  englishStrings: Map<string, string>,
) {
  const exactMatch = englishStrings.get(path);
  if (exactMatch !== undefined) return exactMatch;

  const suffixMatch = path.match(pluralSuffixPattern);
  if (suffixMatch === null) return undefined;

  const stem = path.replace(pluralSuffixPattern, "");
  return (
    englishStrings.get(`${stem}_${suffixMatch[1]}`) ??
    englishStrings.get(`${stem}_other`) ??
    englishStrings.get(`${stem}_one`)
  );
}

function getStringAtPath(catalog: JsonValue, path: string) {
  const value = path.split(".").reduce<JsonValue | undefined>((node, segment) => {
    if (node === null || Array.isArray(node) || typeof node !== "object") {
      return undefined;
    }
    return node[segment];
  }, catalog);

  return typeof value === "string" ? value : undefined;
}

function pluralStems(strings: Map<string, string>) {
  const stems = new Set<string>();
  for (const path of strings.keys()) {
    if (pluralSuffixPattern.test(path)) {
      stems.add(path.replace(pluralSuffixPattern, ""));
    } else if (legacyPluralSuffixPattern.test(path)) {
      stems.add(path.replace(legacyPluralSuffixPattern, ""));
    }
  }
  return stems;
}

function requiredPluralCategories(
  locale: LocaleCode,
) {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

function sortedShapeEntries(catalog: JsonValue) {
  return [...collectShape(catalog).entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

describe("technical code value contract fixture", () => {
  it("reports either translated identifier without blocking translated prose", () => {
    const englishCode =
      '{"stage":"review","column_type":"backlog","title":"review"}';
    const reviewTranslated =
      '{"stage":"revisión","column_type":"backlog","title":"revisión"}';
    const backlogTranslated =
      '{"stage":"review","column_type":"pendiente","title":"revisión"}';
    const proseOnlyTranslated =
      '{"stage":"review","column_type":"backlog","title":"revisión"}';

    expect(
      protectedCodeValueMismatch("fixture.code", englishCode, reviewTranslated),
    ).toContain('received ["backlog"]');
    expect(
      protectedCodeValueMismatch("fixture.code", englishCode, backlogTranslated),
    ).toContain('received ["review"]');
    expect(
      protectedCodeValueMismatch(
        "fixture.code",
        englishCode,
        proseOnlyTranslated,
      ),
    ).toBeUndefined();
  });
});

describe("global locale catalog contract", () => {
  it("keeps the same logical paths and value types in en, es and pt-BR", () => {
    const referenceShape = sortedShapeEntries(catalogs.en);

    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(
        sortedShapeEntries(catalog),
        `${locale} catalog shape differs from en`,
      ).toEqual(referenceShape);
    }
  });

  it("contains no empty translated strings", () => {
    const emptyValues: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [path, value] of collectStrings(catalog)) {
        if (value.trim() === "") emptyValues.push(`${locale}:${path}`);
      }
    }

    expect(emptyValues).toEqual([]);
  });

  // A value equal to its own key path is what i18next prints when a key is
  // MISSING, so shipping one as real copy makes a stub indistinguishable from a
  // bug — and it renders the raw dotted path on screen the moment anything
  // calls t() on it. An empty string is already caught above; this is the same
  // defect wearing the key's own name.
  it("contains no value that is merely its own key path", () => {
    const selfReferential: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [path, value] of collectStrings(catalog)) {
        if (value.trim() === path) selfReferential.push(`${locale}:${path}`);
      }
    }

    expect(selfReferential).toEqual([]);
  });

  it("contains no legacy _plural paths anywhere in a locale catalog", () => {
    const legacyPaths: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const path of collectPaths(catalog)) {
        if (path.endsWith("_plural")) {
          legacyPaths.push(
            `${locale}:${path}: legacy _plural suffix is forbidden; use CLDR plural category suffixes`,
          );
        }
      }
    }

    expect(legacyPaths).toEqual([]);
  });

  it("does not keep redundant zero forms that duplicate the other form", () => {
    const redundantZeroPaths: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      const strings = collectStrings(catalog);
      for (const [path, value] of strings) {
        if (!path.endsWith("_zero")) continue;
        const otherPath = `${path.slice(0, -"_zero".length)}_other`;
        if (strings.get(otherPath) === value) {
          redundantZeroPaths.push(`${locale}:${path}`);
        }
      }
    }

    expect(redundantZeroPaths).toEqual([]);
  });

  it("preserves interpolation placeholders in every locale", () => {
    const englishStrings = collectStrings(catalogs.en);
    const mismatches: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [path, localizedValue] of collectStrings(catalog)) {
        const englishValue = englishTemplateFor(path, englishStrings);
        if (englishValue === undefined) continue;

        const expected = placeholders(englishValue);
        const actual = placeholders(localizedValue);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(
            `${locale}:${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("preserves machine-readable fields and inline technical tokens", () => {
    const englishStrings = collectStrings(catalogs.en);
    const mismatches: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      if (locale === "en") continue;

      for (const [path, localizedValue] of collectStrings(catalog)) {
        const englishValue = englishTemplateFor(path, englishStrings);
        if (englishValue === undefined) continue;

        const isMachineReadableField =
          /\.(href|variant)$/.test(path);
        if (isMachineReadableField && localizedValue !== englishValue) {
          mismatches.push(`${locale}:${path}: machine-readable value changed`);
          continue;
        }

        if (path.endsWith(".code")) {
          const mismatch = protectedCodeValueMismatch(
            path,
            englishValue,
            localizedValue,
          );
          if (mismatch !== undefined) {
            mismatches.push(`${locale}:${mismatch}`);
          }
        }

        const expected = technicalTokens(englishValue);
        const actual = technicalTokens(localizedValue);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(
            `${locale}:${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("defines every plural category selected at runtime for each locale", () => {
    const mismatches: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs) as [
      LocaleCode,
      JsonValue,
    ][]) {
      const strings = collectStrings(catalog);

      for (const stem of pluralStems(strings)) {
        for (const category of requiredPluralCategories(locale)) {
          if (!strings.has(`${stem}_${category}`)) {
            mismatches.push(`${locale}:${stem}_${category}: missing`);
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe("modern lifecycle count plurals", () => {
  it.each(Object.keys(catalogs) as LocaleCode[])(
    "routes singular and plural counts through modern i18next keys in %s",
    async (locale) => {
      const catalog = catalogs[locale];
      const strings = collectStrings(catalog);
      const mismatches: string[] = [];

      for (const stem of legacyPluralStems) {
        if (strings.has(stem)) mismatches.push(`${stem}: legacy bare key remains`);
        if (strings.has(`${stem}_plural`)) {
          mismatches.push(`${stem}_plural: legacy suffix remains`);
        }
        for (const category of requiredPluralCategories(locale)) {
          if (!strings.has(`${stem}_${category}`)) {
            mismatches.push(`${stem}_${category}: missing`);
          }
        }
      }

      expect(mismatches).toEqual([]);

      const i18n = createInstance();
      await i18n.init({
        resources: {
          [locale]: { translation: catalog as unknown as ResourceLanguage },
        },
        lng: locale,
        fallbackLng: false,
        interpolation: { escapeValue: false },
      });

      for (const stem of legacyPluralStems) {
        for (const count of [0, 1, 2, 1_000_000]) {
          const exactZeroPath = `${stem}_zero`;
          const category = new Intl.PluralRules(locale).select(count);
          const selectedPath =
            count === 0 && strings.has(exactZeroPath)
              ? exactZeroPath
              : `${stem}_${category}`;
          expect(i18n.t(stem, { count })).toBe(
            getStringAtPath(catalog, selectedPath)?.replace(
              "{{count}}",
              String(count),
            ),
          );
        }
      }
    },
  );
});
