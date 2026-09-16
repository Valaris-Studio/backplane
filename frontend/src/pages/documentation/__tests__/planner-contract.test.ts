// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getMissingDocumentationStrings, getUnexpectedDocumentationStrings } from "../section-registry";

describe("default planner documentation", () => {
  it("describes a plan note for the existing card", () => {
    const section = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../sections/core-concepts-roles-and-pipelines.tsx"), "utf8");
    expect(section).toContain("single plan note");
    expect(section).not.toContain("implementable child cards");
  });
  it.each(["es", "pt-BR"] as const)("keeps %s planner narrative current", (locale) => {
    expect(getMissingDocumentationStrings(locale, "roles-and-pipelines")).toEqual([]);
    expect(getUnexpectedDocumentationStrings(locale, "roles-and-pipelines")).toEqual([]);
  });
  it.each(["en", "es", "pt-BR"])("does not present the %s default planner as a bulk creator", (locale) => {
    const strings = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../i18n/locales", `${locale}.json`), "utf8");
    expect(strings).not.toMatch(/mutates_backlog: (?:the planner|el planner|o planner)/);
    expect(strings).not.toMatch(/Planner run: one-to-many|Corrida de planner: una o varias|Execução de planner: de um a muitos/);
  });
});
