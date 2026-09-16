// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";
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

// docs/git-credentials.md is the source of truth for the Git Connections
// panel; the in-app reference must name the panel, its Verify checks and the
// keys an operator has to provision, or the feature is undiscoverable.
const GIT_CONFIGURATION_SLUG = "git-configuration-and-review-modes";
const ENVIRONMENT_VARIABLES_SLUG = "environment-variables";
const DOCUMENTED_SLUGS = [GIT_CONFIGURATION_SLUG, ENVIRONMENT_VARIABLES_SLUG] as const;
const LOCALIZED_LOCALES = ["es", "pt-BR"] as const;

// The docs must send readers to the panel by the name the localized UI shows,
// which is the app's own catalog value, not the English product noun.
const UI_LABELS: Record<
  (typeof LOCALIZED_LOCALES)[number],
  { panelTitle: string; settingsTitle: string }
> = {
  es: { panelTitle: es.integrations.title, settingsTitle: es.settings.title },
  "pt-BR": { panelTitle: ptBR.integrations.title, settingsTitle: ptBR.settings.title },
};

const VERIFY_CHECK_NAMES = ["identity", "scopes", "scope:repo", "scope:api", "ci-read"];
const GIT_CONNECTION_ENV_KEYS = ["INTEGRATIONS_TOKEN_KEY", "ALLOW_GLOBAL_TOKEN_FALLBACK"];
const OAUTH_ENV_KEYS = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "OAUTH_STATE_SIGNING_KEY",
];

// The credentialed process is a "runner". Pre-existing "agent" usages in
// these two sections (coding agent, MCP agent, agent identity) are frozen
// here so new copy cannot reintroduce the word for the runner.
const PRE_EXISTING_AGENT_STRINGS: Readonly<Record<string, readonly string[]>> = {
  [GIT_CONFIGURATION_SLUG]: [],
  [ENVIRONMENT_VARIABLES_SLUG]: [
    "), either personal or linked to a registered agent. When set, all other auth paths are skipped and",
  ],
};

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

function envRowPurpose(container: HTMLElement, name: string) {
  const cell = [...container.querySelectorAll("td code")].find(
    (node) => node.textContent?.trim() === name,
  );
  expect(cell, `no <code>${name}</code> cell in the environment variables table`).toBeDefined();
  return (cell?.closest("tr")?.textContent ?? "").replace(/\s+/g, " ");
}

afterEach(cleanup);

describe("Git Connections in-app documentation", () => {
  describe("git configuration section (en)", () => {
    it("names the Git Connections panel and where it lives", () => {
      const { text } = renderSection("en", GIT_CONFIGURATION_SLUG);
      expect(text).toContain("Git Connections");
      expect(text).toContain("Workspace Settings");
    });

    it("documents Verify and connection health", () => {
      const { text } = renderSection("en", GIT_CONFIGURATION_SLUG);
      expect(text).toContain("Verify");
      expect(text).toContain("health");
    });

    it.each(VERIFY_CHECK_NAMES)("lists the Verify check %s as a code identifier", (check) => {
      const { container } = renderSection("en", GIT_CONFIGURATION_SLUG);
      expect(codeTexts(container)).toContain(check);
    });

    it.each(GIT_CONNECTION_ENV_KEYS)("points operators at %s", (key) => {
      const { container } = renderSection("en", GIT_CONFIGURATION_SLUG);
      expect(codeTexts(container)).toContain(key);
    });
  });

  describe("environment variables section (en)", () => {
    it("ties INTEGRATIONS_TOKEN_KEY to the Git Connections panel and its Fernet format", () => {
      const { container } = renderSection("en", ENVIRONMENT_VARIABLES_SLUG);
      const purpose = envRowPurpose(container, "INTEGRATIONS_TOKEN_KEY");
      expect(purpose).toContain("Fernet");
      expect(purpose).toContain("Git Connections");
    });

    it("ties ALLOW_GLOBAL_TOKEN_FALLBACK to the Git Connections resolution order", () => {
      const { container } = renderSection("en", ENVIRONMENT_VARIABLES_SLUG);
      expect(envRowPurpose(container, "ALLOW_GLOBAL_TOKEN_FALLBACK")).toContain(
        "Git Connections",
      );
    });

    it.each(OAUTH_ENV_KEYS)("keeps the %s row", (key) => {
      const { container } = renderSection("en", ENVIRONMENT_VARIABLES_SLUG);
      expect(envRowPurpose(container, key).length).toBeGreaterThan(key.length);
    });
  });

  // documentation-locales.contract.test.ts pins this for every section; it is
  // repeated here so a new English string without es + pt-BR entries fails
  // next to the copy it belongs to, not in a 55-section sweep.
  describe.each(LOCALIZED_LOCALES)("%s parity", (locale) => {
    it.each(DOCUMENTED_SLUGS)("keeps %s fully translated", (slug) => {
      expect(getMissingDocumentationStrings(locale, slug)).toEqual([]);
      expect(getUnexpectedDocumentationStrings(locale, slug)).toEqual([]);
      expect(resolveDocumentationSection(locale, slug)?.status).toBe("translated");
    });

    it.each(DOCUMENTED_SLUGS)(
      "renders %s with the English product noun and the same code identifiers as en",
      (slug) => {
        const source = renderSection("en", slug);
        const sourceCodes = codeTexts(source.container);
        cleanup();

        const localized = renderSection(locale, slug);
        expect(localized.status).toBe("translated");
        expect(localized.text).toContain("Git Connections");
        expect(codeTexts(localized.container)).toEqual(sourceCodes);
      },
    );

    it("names the panel by the title the localized UI shows", () => {
      const { text } = renderSection(locale, GIT_CONFIGURATION_SLUG);
      expect(text).toContain(UI_LABELS[locale].panelTitle);
    });

    it("names Workspace Settings by the title the localized UI shows", () => {
      const { text } = renderSection(locale, GIT_CONFIGURATION_SLUG);
      expect(text).toContain(UI_LABELS[locale].settingsTitle);
    });
  });

  // pt-BR still carried the pre-rename "Integrações" after en/es moved to
  // "Git Connections"/"Conexiones Git"; the docs and UI must agree on one name.
  it("pt-BR integrations.title is the renamed Git Connections label", () => {
    expect(ptBR.integrations.title).not.toBe("Integrações");
    expect(ptBR.integrations.title).toContain("Git");
  });

  // en/es describe the credentials Backplane uses on your repositories; pt-BR
  // still carried the pre-rename "connect external services" pitch.
  it("pt-BR integrations.subtitle carries the credentials framing", () => {
    expect(ptBR.integrations.subtitle).toContain("credenciais");
    expect(ptBR.integrations.subtitle).not.toContain("serviços externos");
  });

  describe.each(DOCUMENTED_SLUGS)("vocabulary in %s", (slug) => {
    it("does not introduce 'agent' beyond the pre-existing usages", () => {
      const agentStrings = getDocumentationSourceStrings(slug).filter((value) =>
        /\bagents?\b/i.test(value),
      );
      const allowed = PRE_EXISTING_AGENT_STRINGS[slug] ?? [];
      expect(agentStrings.filter((value) => !allowed.includes(value))).toEqual([]);
    });
  });
});
