// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ES_CONFIGURATION } from "../content/sections/es/configuration";
import { ES_EXTENDING } from "../content/sections/es/extending";
import { PT_BR_CONFIGURATION } from "../content/sections/pt-BR/configuration";
import { PT_BR_EXTENDING } from "../content/sections/pt-BR/extending";
import {
  collectDocumentationTranslatableStrings,
  DocumentationSectionTranslationProvider,
  type DocumentationSectionTranslations,
} from "../section-localization";
import { ConfigurationApprovalCategoriesAndRiskScoring } from "../sections/configuration-approval-categories-and-risk-scoring";
import { ConfigurationGitConfigurationAndReviewModes } from "../sections/configuration-git-configuration-and-review-modes";
import { ConfigurationPipelineBuilder } from "../sections/configuration-pipeline-builder";
import { ExtendingIntegratingANewGitHost } from "../sections/extending-integrating-a-new-git-host";

afterEach(cleanup);

function renderText(Component: () => ReactElement) {
  const { container } = render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
  return container.textContent ?? "";
}

function renderLocalizedText(
  Component: () => ReactElement,
  translations: DocumentationSectionTranslations,
) {
  const { container } = render(
    <MemoryRouter>
      <DocumentationSectionTranslationProvider translations={translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function sourceNarrative(Component: () => ReactElement) {
  const section = Component();
  const children = (section.props as { children?: ReactNode }).children;
  return collectDocumentationTranslatableStrings(children);
}

const ownedSections = {
  "pipeline-builder": ConfigurationPipelineBuilder,
  "approval-categories-and-risk-scoring":
    ConfigurationApprovalCategoriesAndRiskScoring,
  "git-configuration-and-review-modes":
    ConfigurationGitConfigurationAndReviewModes,
  "integrating-a-new-git-host": ExtendingIntegratingANewGitHost,
} as const;

const localeSections = {
  es: { ...ES_CONFIGURATION, ...ES_EXTENDING },
  "pt-BR": { ...PT_BR_CONFIGURATION, ...PT_BR_EXTENDING },
} as const;

describe("configuration and extending documentation against main", () => {
  it("documents the one lifecycle draft through Graph, Tree and the legacy Form", () => {
    const text = renderText(ConfigurationPipelineBuilder);

    expect(text).toContain("one shared lifecycle draft");
    expect(text).toContain("Graph");
    expect(text).toContain("Tree");
    expect(text).toContain("legacy Form");
    expect(text).toContain("When lifecycle is non-empty");
    expect(text).not.toMatch(/\b(?:Export|Import) JSON\b/);
  });

  it("documents the active merge path and the real credential and forge boundaries", () => {
    const configuration = renderText(ConfigurationGitConfigurationAndReviewModes);
    const extending = renderText(ExtendingIntegratingANewGitHost);

    expect(configuration).toContain("merge_pr");
    expect(configuration).toContain("merge_via_queue");
    expect(configuration).toContain("GitHub, GitLab, and Gitea");
    expect(configuration).not.toContain("MergeTrigger");
    expect(configuration).not.toContain("auto-merge");

    expect(extending).toContain("forge.Provider");
    expect(extending).toContain("GitHub and Gitea/Forgejo drivers");
    expect(extending).toContain("GitLab driver is not implemented");
    expect(extending).not.toContain("Today Backplane assumes GitHub");
  });

  it("keeps the approval category contract exact", () => {
    const text = renderText(ConfigurationApprovalCategoriesAndRiskScoring);
    const categories = Array.from(
      text.matchAll(/ApprovalCategory\.(\w+)/g),
      ([, category]) => category,
    );

    expect(categories).toEqual([
      "deletion",
      "bulk_change",
      "deployment",
      "schema_change",
      "permission_change",
      "external_action",
      "skill_publication",
    ]);
    expect(text).toContain("checks workspace membership but no minimum role");
    expect(text).toContain("owner, admin, member, or viewer");
    expect(text).not.toContain("An admin drains the queue");
  });

  it("keeps existing deep-link anchors while adding the current sections", () => {
    for (const [Component, anchors] of [
      [
        ConfigurationPipelineBuilder,
        [
          "stage-anatomy",
          "discover-strategies",
          "claim-git-and-llm",
          "actions-and-branching",
          "scheduling",
        ],
      ],
      [
        ConfigurationGitConfigurationAndReviewModes,
        [
          "review-mode",
          "merge-trigger",
          "branch-prefix-and-safety",
          "what-this-is-not",
        ],
      ],
      [
        ExtendingIntegratingANewGitHost,
        ["todays-surface", "proposed-interface", "integration-surface"],
      ],
    ] as const) {
      const { container } = render(
        <MemoryRouter>
          <Component />
        </MemoryRouter>,
      );
      for (const anchor of anchors) {
        expect(container.querySelector(`#${anchor}`)).not.toBeNull();
      }
    }
  });

  it.each(["es", "pt-BR"] as const)(
    "keeps the corrected sections complete in %s",
    (locale) => {
      const incomplete: Record<
        string,
        { missing: string[]; unexpected: string[] }
      > = {};
      for (const [slug, Component] of Object.entries(ownedSections)) {
        const source = new Set(sourceNarrative(Component));
        const translations = localeSections[locale][
          slug as keyof (typeof localeSections)[typeof locale]
        ] as Readonly<Record<string, string>>;
        const translated = new Set(Object.keys(translations));
        const missing = [...source].filter((value) => !translated.has(value));
        const unexpected = [...translated].filter((value) => !source.has(value));
        if (missing.length > 0 || unexpected.length > 0) {
          incomplete[slug] = { missing, unexpected };
        }
      }

      expect(incomplete).toEqual({});
    },
  );

  it("composes the corrected Spanish copy around stable technical tokens", () => {
    const pipeline = renderLocalizedText(
      ConfigurationPipelineBuilder,
      ES_CONFIGURATION["pipeline-builder"],
    );
    const git = renderLocalizedText(
      ConfigurationGitConfigurationAndReviewModes,
      ES_CONFIGURATION["git-configuration-and-review-modes"],
    );
    const extending = renderLocalizedText(
      ExtendingIntegratingANewGitHost,
      ES_EXTENDING["integrating-a-new-git-host"],
    );

    expect(pipeline).toContain("rutas mediante next, branches o on_failure.");
    expect(pipeline).toContain(
      "bloques planos heredados discover, claim, git, llm, sensors, on_success y on_failure.",
    );
    expect(git).toContain("GitHub, GitLab y Gitea");
    expect(git).toContain("Cuando el indicador es false o no está presente");
    expect(extending).toContain("No hay un driver de GitLab implementado.");
    expect(extending).toContain(
      "GitHub encapsula los métodos existentes, basados en gh, de git.Manager.",
    );
  });

  it("composes the corrected PT-BR copy around stable technical tokens", () => {
    const pipeline = renderLocalizedText(
      ConfigurationPipelineBuilder,
      PT_BR_CONFIGURATION["pipeline-builder"],
    );
    const git = renderLocalizedText(
      ConfigurationGitConfigurationAndReviewModes,
      PT_BR_CONFIGURATION["git-configuration-and-review-modes"],
    );
    const extending = renderLocalizedText(
      ExtendingIntegratingANewGitHost,
      PT_BR_EXTENDING["integrating-a-new-git-host"],
    );

    expect(pipeline).toContain("roteamento por next, branches ou on_failure.");
    expect(pipeline).toContain(
      "blocos planos legados discover, claim, git, llm, sensors, on_success e on_failure.",
    );
    expect(git).toContain("GitHub, GitLab e Gitea");
    expect(git).toContain("Quando o indicador é false ou está ausente");
    expect(extending).toContain("Um driver para GitLab não foi implementado.");
    expect(extending).toContain(
      "GitHub encapsula os métodos existentes, baseados em gh, de git.Manager.",
    );
  });
});
