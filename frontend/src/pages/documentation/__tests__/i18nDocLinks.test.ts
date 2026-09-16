// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "../../../i18n/locales/en.json";
import es from "../../../i18n/locales/es.json";
import ptBr from "../../../i18n/locales/pt-BR.json";
import { DOC_SECTIONS } from "../routes";

const DOC_HREF_PREFIX = "documentation/";

function collectDocHrefs(node: unknown, found: string[]): string[] {
  if (typeof node === "string") {
    if (node.startsWith(DOC_HREF_PREFIX)) found.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) collectDocHrefs(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) collectDocHrefs(value, found);
  }
  return found;
}

const validSlugs: ReadonlySet<string> = new Set(
  DOC_SECTIONS.map((section) => section.slug),
);

describe.each([
  ["en", en],
  ["es", es],
  ["pt-BR", ptBr],
] as const)("%s locale documentation hrefs", (_lang, locale) => {
  const hrefs = collectDocHrefs(locale, []);

  it("contains documentation hrefs (walker sanity check)", () => {
    expect(hrefs.length).toBeGreaterThan(0);
  });

  it("every documentation/... href resolves to a DOC_SECTIONS slug", () => {
    const broken = hrefs.filter((href) => {
      // Tolerate anchors/query strings appended to a section slug.
      const slug = href.slice(DOC_HREF_PREFIX.length).split(/[#?]/)[0] ?? "";
      return !validSlugs.has(slug);
    });
    expect(broken).toEqual([]);
  });
});
