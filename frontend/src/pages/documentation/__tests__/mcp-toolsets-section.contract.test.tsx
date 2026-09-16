// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import { ES_SECTION_TRANSLATIONS } from "../content/sections/es";
import { PT_BR_SECTION_TRANSLATIONS } from "../content/sections/pt-BR";
import serverSurfaceJson from "../mcp-reference/data/server-surface.json";
import { DOC_SECTIONS } from "../routes";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import {
  getDocumentationSourceStrings,
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
  resolveDocumentationSection,
} from "../section-registry";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// The MCP Toolsets reference renders from server-surface.json (toolsets +
// default_toolset, exported by mcp-server/scripts/export-tool-catalog.py).
// Tool counts are DERIVED from the fixture's per-toolset `tools` arrays and
// rendered as separate children: a numeral inside a translatable string would
// mint a new translation key on every server release and drop the whole
// section to English fallback (same rule as the tool catalog summary).
const SLUG = "mcp-toolsets";
const ENVIRONMENT_VARIABLES_SLUG = "environment-variables";
const ENV_VAR = "VALARIS_MCP_TOOLSETS";
const LOCALIZED_LOCALES = ["es", "pt-BR"] as const;
const REGEN_HINT =
  "server-surface.json has no toolsets/default_toolset — regenerate: cd mcp-server && .venv/bin/python scripts/export-tool-catalog.py";

interface FixtureToolset {
  id: string;
  kind: "group" | "category";
  title: string;
  group: string;
  tools: string[];
}

interface FixtureDefaultToolset {
  ids: string[];
  exclusions: Record<string, string>;
  inclusions: Record<string, string>;
  tools: string[];
}

interface FixtureDeprecatedAlias {
  replacement: string;
  removed_in: string;
}

interface FixtureWithToolsets {
  toolsets?: FixtureToolset[];
  default_toolset?: FixtureDefaultToolset;
  deprecated?: Record<string, FixtureDeprecatedAlias>;
}

function loadToolsetsFixture(): {
  toolsets: FixtureToolset[];
  defaultToolset: FixtureDefaultToolset;
} {
  const surface = serverSurfaceJson as FixtureWithToolsets;
  expect(Array.isArray(surface.toolsets), REGEN_HINT).toBe(true);
  expect(surface.default_toolset, REGEN_HINT).toBeTypeOf("object");
  return {
    toolsets: surface.toolsets as FixtureToolset[],
    defaultToolset: surface.default_toolset as FixtureDefaultToolset,
  };
}

// Same detectors as mcp-tool-catalog-no-frozen-counts.contract.test.tsx.
const FROZEN_TOOL_COUNT = /\d+\s+(tools|herramientas|ferramentas)\b/i;
const FROZEN_CATEGORY_COUNT = /\d+\s+categor(ies|ías|ias)\b/i;
const TRAILING_COUNT =
  /\b(tools|herramientas|ferramentas|categor(?:ies|ías|ias))\b[^\d\n]{0,30}\d+/i;

function hasFrozenCount(value: string) {
  return (
    FROZEN_TOOL_COUNT.test(value) ||
    FROZEN_CATEGORY_COUNT.test(value) ||
    TRAILING_COUNT.test(value)
  );
}

const TRANSLATION_MAPS = {
  es: ES_SECTION_TRANSLATIONS[SLUG],
  "pt-BR": PT_BR_SECTION_TRANSLATIONS[SLUG],
} as const;

function renderSection(locale: SupportedLanguage, slug: string) {
  const resolved = resolveDocumentationSection(locale, slug);
  if (!resolved) throw new Error(`Missing documentation section: ${locale}:${slug}`);
  const Component = resolved.Component;
  const view = render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider translations={resolved.translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return {
    status: resolved.status,
    container: view.container,
    text: (view.container.textContent ?? "").replace(/\s+/g, " "),
  };
}

function codeTexts(container: HTMLElement) {
  return [...container.querySelectorAll("code")].map(
    (node) => node.textContent?.trim() ?? "",
  );
}

// The toolset table has one row per toolset; the row is found by the id it
// shows in a <code> cell, then asserted to carry the derived count.
function toolsetRowText(container: HTMLElement, toolsetId: string) {
  const cell = [...container.querySelectorAll("tr code")].find(
    (node) => node.textContent?.trim() === toolsetId,
  );
  expect(cell, `no <code>${toolsetId}</code> cell in the toolsets table`).toBeDefined();
  return (cell?.closest("tr")?.textContent ?? "").replace(/\s+/g, " ");
}

// Every node between the h2 with `headingId` and the next h2. Ids, names and
// versions there must be <code>; reasons and replacements are plain text.
function headingBlock(container: HTMLElement, headingId: string) {
  const heading = container.querySelector(`h2#${headingId}`);
  expect(heading, `no h2#${headingId} heading`).not.toBeNull();
  const nodes: Element[] = [];
  for (let node = heading?.nextElementSibling; node && node.tagName !== "H2"; node = node.nextElementSibling) {
    nodes.push(node);
  }
  return {
    codes: nodes.flatMap((node) =>
      [...node.querySelectorAll("code")].map((code) => code.textContent?.trim() ?? ""),
    ),
    text: nodes.map((node) => node.textContent ?? "").join(" ").replace(/\s+/g, " "),
  };
}

function defaultHandBlock(container: HTMLElement) {
  return headingBlock(container, "default-hand");
}

function envRowPurpose(container: HTMLElement, name: string) {
  const cell = [...container.querySelectorAll("td code")].find(
    (node) => node.textContent?.trim() === name,
  );
  expect(cell, `no <code>${name}</code> cell in the environment variables table`).toBeDefined();
  return (cell?.closest("tr")?.textContent ?? "").replace(/\s+/g, " ");
}

afterEach(cleanup);

describe("MCP Toolsets reference section", () => {
  describe("routing", () => {
    it("registers mcp-toolsets under reference at order 15 (between tool catalog 10 and prompt catalog 20)", () => {
      expect(DOC_SECTIONS).toContainEqual(
        expect.objectContaining({ slug: SLUG, group: "reference", order: 15 }),
      );
      const reference = DOC_SECTIONS.filter(({ group }) => group === "reference")
        .slice()
        .sort((a, b) => a.order - b.order)
        .map(({ slug }) => slug);
      const index = reference.indexOf(SLUG);
      expect(reference[index - 1]).toBe("mcp-tool-catalog");
      expect(reference[index + 1]).toBe("mcp-prompt-catalog");
    });

    it("titles the section MCP Toolsets in the English source", () => {
      expect(DOC_SECTIONS.find(({ slug }) => slug === SLUG)?.title).toBe("MCP Toolsets");
    });
  });

  describe("resolution", () => {
    it("resolves the English source", () => {
      const resolved = resolveDocumentationSection("en", SLUG);
      expect(resolved).toBeDefined();
      expect(resolved?.Component).toBeTypeOf("function");
      expect(resolved?.status).toBe("source");
    });

    it.each(LOCALIZED_LOCALES)("resolves %s as fully translated", (locale) => {
      expect(getMissingDocumentationStrings(locale, SLUG)).toEqual([]);
      expect(getUnexpectedDocumentationStrings(locale, SLUG)).toEqual([]);
      expect(resolveDocumentationSection(locale, SLUG)?.status).toBe("translated");
    });
  });

  describe("rendered content (en)", () => {
    it("names the env var and the two reserved words", () => {
      const { text, container } = renderSection("en", SLUG);
      expect(text).toContain(ENV_VAR);
      expect(codeTexts(container)).toContain(ENV_VAR);
      expect(codeTexts(container)).toContain("all");
      expect(codeTexts(container)).toContain("default");
    });

    it("shows the env examples from the design as copyable code", () => {
      const { container } = renderSection("en", SLUG);
      const codes = codeTexts(container);
      expect(codes).toContain("default,autonomous-operations");
      expect(codes).toContain("cards,notes");
    });

    it("lists every toolset id from the fixture", () => {
      const { toolsets } = loadToolsetsFixture();
      const { container } = renderSection("en", SLUG);
      const codes = codeTexts(container);
      const missing = toolsets.map(({ id }) => id).filter((id) => !codes.includes(id));
      expect(missing).toEqual([]);
    });

    it("shows a tool count per toolset derived from the fixture's tools array", () => {
      const { toolsets } = loadToolsetsFixture();
      const { container } = renderSection("en", SLUG);
      const drift = toolsets.flatMap(({ id, tools }) => {
        const row = toolsetRowText(container, id);
        return new RegExp(`\\b${tools.length}\\b`).test(row)
          ? []
          : [{ id, expected: tools.length, row }];
      });
      expect(drift).toEqual([]);
    });

    it("shows each toolset's group next to its id", () => {
      const { toolsets } = loadToolsetsFixture();
      const { container } = renderSection("en", SLUG);
      const drift = toolsets.flatMap(({ id, group }) =>
        toolsetRowText(container, id).includes(group) ? [] : [{ id, group }],
      );
      expect(drift).toEqual([]);
    });

    it("lists the default hand's toolset ids and every exclusion with its reason", () => {
      const { defaultToolset } = loadToolsetsFixture();
      const { text, container } = renderSection("en", SLUG);
      const codes = codeTexts(container);
      for (const id of defaultToolset.ids) {
        expect(codes, `default toolset id ${id} not rendered as code`).toContain(id);
      }
      for (const [name, reason] of Object.entries(defaultToolset.exclusions)) {
        expect(codes, `exclusion ${name} not rendered as code`).toContain(name);
        expect(text, `reason for ${name} missing`).toContain(reason);
      }
    });

    it("lists every inclusion as code with its reason inside the default-hand block", () => {
      const { defaultToolset } = loadToolsetsFixture();
      expect(Object.keys(defaultToolset.inclusions).length).toBeGreaterThan(0);
      const { container } = renderSection("en", SLUG);
      const block = defaultHandBlock(container);
      for (const [name, reason] of Object.entries(defaultToolset.inclusions)) {
        expect(block.codes, `inclusion ${name} not rendered as code`).toContain(name);
        expect(block.text, `reason for ${name} missing`).toContain(reason);
      }
    });

    it("derives the opt-in group ids (group toolsets outside the default hand) and renders them as code", () => {
      const { toolsets, defaultToolset } = loadToolsetsFixture();
      const optIn = toolsets
        .filter(({ kind, id }) => kind === "group" && !defaultToolset.ids.includes(id))
        .map(({ id }) => id);
      expect(optIn.length).toBeGreaterThan(0);
      const { container } = renderSection("en", SLUG);
      const block = defaultHandBlock(container);
      for (const id of optIn) {
        expect(block.codes, `opt-in group ${id} not rendered as code in the default-hand block`).toContain(id);
      }
    });

    // Deprecated aliases are outside `tools` and every toolset; the block is
    // derived from the fixture's `deprecated` map and disappears with it.
    it("lists every deprecated alias from the fixture as code with its replacement and removal version, or renders no block when the map is empty", () => {
      const deprecated = Object.entries(
        (serverSurfaceJson as FixtureWithToolsets).deprecated ?? {},
      );
      const { container } = renderSection("en", SLUG);
      if (deprecated.length === 0) {
        expect(container.querySelector("h2#deprecated-aliases")).toBeNull();
        return;
      }
      const block = headingBlock(container, "deprecated-aliases");
      for (const [name, { replacement, removed_in }] of deprecated) {
        expect(block.codes, `deprecated alias ${name} not rendered as code`).toContain(name);
        expect(block.text, `replacement for ${name} missing`).toContain(replacement);
        expect(block.codes, `removal version for ${name} not rendered as code`).toContain(removed_in);
      }
    });

    it("keeps every deprecated alias out of the toolset rows and the default hand", () => {
      const { toolsets, defaultToolset } = loadToolsetsFixture();
      const aliases = Object.keys((serverSurfaceJson as FixtureWithToolsets).deprecated ?? {});
      const leaked = aliases.filter(
        (alias) =>
          defaultToolset.tools.includes(alias) ||
          toolsets.some(({ tools }) => tools.includes(alias)),
      );
      expect(leaked).toEqual([]);
    });

    it("keeps every group id out of the translatable prose", () => {
      const { toolsets } = loadToolsetsFixture();
      const groupIds = toolsets.filter(({ kind }) => kind === "group").map(({ id }) => id);
      const offenders = getDocumentationSourceStrings(SLUG).filter((value) =>
        groupIds.some((id) => new RegExp(`\\b${id}\\b`).test(value)),
      );
      expect(offenders).toEqual([]);
    });

    it("shows the default hand's size derived from the fixture", () => {
      const { defaultToolset } = loadToolsetsFixture();
      const { text } = renderSection("en", SLUG);
      expect(text).toMatch(new RegExp(`\\b${defaultToolset.tools.length}\\b`));
    });

    it("explains composition with the allowlist", () => {
      const { text, container } = renderSection("en", SLUG);
      expect(codeTexts(container)).toContain("VALARIS_MCP_ALLOWLIST");
      expect(text).toMatch(/intersection/i);
    });
  });

  describe("no frozen counts", () => {
    it("emits no translatable source string with a numeral glued to tools/categories", () => {
      const offenders = getDocumentationSourceStrings(SLUG).filter(hasFrozenCount);
      expect(offenders).toEqual([]);
    });

    it.each(LOCALIZED_LOCALES)(
      "%s translation map has no key or value with a numeral glued to tools/categories",
      (locale) => {
        const map = TRANSLATION_MAPS[locale];
        expect(map, `${locale} has no ${SLUG} translation map`).toBeDefined();
        const offenders = Object.entries(map ?? {}).flatMap(([source, localized]) => [
          ...(hasFrozenCount(source) ? [{ locale, side: "key", text: source }] : []),
          ...(hasFrozenCount(localized) ? [{ locale, side: "value", text: localized }] : []),
        ]);
        expect(offenders).toEqual([]);
      },
    );
  });

  describe.each(LOCALIZED_LOCALES)("%s rendering", (locale) => {
    it("renders translated with the same code identifiers and derived counts as en", () => {
      const { toolsets } = loadToolsetsFixture();
      const source = renderSection("en", SLUG);
      const sourceCodes = codeTexts(source.container);
      cleanup();

      const localized = renderSection(locale, SLUG);
      expect(localized.status).toBe("translated");
      expect(localized.text).toContain(ENV_VAR);
      expect(codeTexts(localized.container)).toEqual(sourceCodes);
      for (const { id, tools } of toolsets) {
        expect(toolsetRowText(localized.container, id)).toMatch(
          new RegExp(`\\b${tools.length}\\b`),
        );
      }
    });
  });
});

describe("Environment Variables reference — VALARIS_MCP_TOOLSETS row", () => {
  it("documents VALARIS_MCP_TOOLSETS right after the allowlist row", () => {
    const { text, container } = renderSection("en", ENVIRONMENT_VARIABLES_SLUG);
    expect(text).toContain(ENV_VAR);

    const purpose = envRowPurpose(container, ENV_VAR);
    expect(purpose).toContain("default");
    expect(purpose).toContain("all");

    // Variable names live in the first column; purpose cells carry their own
    // <code> literals (e.g. `*`, `__none__`), which must not shift the order.
    const names = [...container.querySelectorAll("td:first-child code")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(names.indexOf(ENV_VAR)).toBe(names.indexOf("VALARIS_MCP_ALLOWLIST") + 1);
  });

  it.each(LOCALIZED_LOCALES)("%s keeps the page translated and renders the row", (locale) => {
    expect(getMissingDocumentationStrings(locale, ENVIRONMENT_VARIABLES_SLUG)).toEqual([]);
    expect(getUnexpectedDocumentationStrings(locale, ENVIRONMENT_VARIABLES_SLUG)).toEqual([]);
    const { status, container } = renderSection(locale, ENVIRONMENT_VARIABLES_SLUG);
    expect(status).toBe("translated");
    expect(envRowPurpose(container, ENV_VAR).length).toBeGreaterThan(ENV_VAR.length);
  });
});
