// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resolveDocumentationSection, getMissingDocumentationStrings, getUnexpectedDocumentationStrings } from "../section-registry";
import { DocumentationSectionTranslationProvider } from "../section-localization";

afterEach(cleanup);

it.each(["en", "es", "pt-BR"] as const)("renders honest loop and skill boundaries in %s", (locale) => {
  for (const slug of ["loop-mode", "skills"]) {
    const section = resolveDocumentationSection(locale, slug)!;
    const Component = section.Component;
    const view = render(<MemoryRouter><DocumentationSectionTranslationProvider translations={section.translations}><Component /></DocumentationSectionTranslationProvider></MemoryRouter>);
    const text = view.container.textContent ?? "";
    if (slug === "loop-mode") {
      expect(text).toContain("next_assignment");
      expect(text).toContain("blocked_on_human");
      expect(text).toContain("enforce_done_merge_gate");
      expect(text).toContain("completion_policy");
      expect(text).toContain("get_completion_status");
    } else {
      expect(text).toContain({en: "authorized human workspace admin", es: "administrador humano autorizado del espacio de trabajo", "pt-BR": "administrador humano autorizado do espaço de trabalho"}[locale]);
      expect(text).toContain({en: "a runner-bound agent works a card", es: "un agente vinculado a un runner trabaja en una tarjeta", "pt-BR": "um agente vinculado a um runner trabalha em um cartão"}[locale]);
      expect(text).toContain("403");
      expect(text).toContain("propose_skill");
    }
    if (locale !== "en") {
      expect(getMissingDocumentationStrings(locale, slug)).toEqual([]);
      expect(getUnexpectedDocumentationStrings(locale, slug)).toEqual([]);
    }
    view.unmount();
  }
});
