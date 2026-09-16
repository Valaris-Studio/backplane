// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBr from "../locales/pt-BR.json";

type Catalog = Record<string, unknown>;
type Locale = "en" | "es" | "pt-BR";

const catalogs: Record<Locale, Catalog> = {
  en,
  es,
  "pt-BR": ptBr,
};

function readCatalogPath(catalog: Catalog, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Catalog)[segment];
  }, catalog);
}

function expectTerms(
  paths: readonly string[],
  expectedByLocale: Record<Locale, string>,
) {
  for (const [locale, catalog] of Object.entries(catalogs) as [
    Locale,
    Catalog,
  ][]) {
    for (const path of paths) {
      expect(
        readCatalogPath(catalog, path),
        `${locale}:${path}`,
      ).toBe(expectedByLocale[locale]);
    }
  }
}

describe("approved Backplane product terminology", () => {
  it("uses the approved participant-role names on every role picker surface", () => {
    expectTerms(
      [
        "timeline.roles.hero",
        "cards.roles.hero",
        "pipelineBuilder.lifecycle.kinds.claim.params.participant_role.options.hero",
      ],
      {
        en: "Primary owner",
        es: "Responsable principal",
        "pt-BR": "Responsável principal",
      },
    );

    expectTerms(
      [
        "timeline.roles.helper",
        "cards.roles.helper",
        "pipelineBuilder.lifecycle.kinds.claim.params.participant_role.options.helper",
      ],
      {
        en: "Collaborator",
        es: "Colaborador",
        "pt-BR": "Colaborador",
      },
    );

    expectTerms(["timeline.roles.viewer", "cards.roles.viewer"], {
      en: "Observer",
      es: "Observador",
      "pt-BR": "Observador",
    });

    expectTerms(["timeline.roles.stakeholder", "cards.roles.stakeholder"], {
      en: "Stakeholder",
      es: "Parte interesada",
      "pt-BR": "Parte interessada",
    });
  });

  it("keeps permission, ownership, and assignment terms distinct", () => {
    expectTerms(["members.roles.owner"], {
      en: "owner",
      es: "propietario",
      "pt-BR": "proprietário",
    });

    expectTerms(["members.roles.viewer"], {
      en: "viewer",
      es: "lector",
      "pt-BR": "visualizador",
    });

    expectTerms(
      ["kanban.table.headers.assignee", "kanban.filterBar.filter.assignees"],
      {
        en: "Assignee",
        es: "Responsable",
        "pt-BR": "Responsável",
      },
    );

    expectTerms(["cards.heroExists"], {
      en: "Card already has a primary owner",
      es: "La tarjeta ya tiene un responsable principal",
      "pt-BR": "O cartão já tem um responsável principal",
    });

    expectTerms(["agentic.card.reasonNoHero.title"], {
      en: "No primary owner assigned",
      es: "Sin responsable principal asignado",
      "pt-BR": "Nenhum responsável principal atribuído",
    });
  });

  it("uses the approved documentation-owner label without changing its identifier", () => {
    expectTerms(
      ["teams.roles.documentator", "rolesGlossary.roles.documentator.name"],
      {
        en: "Documentation owner",
        es: "Responsable de documentación",
        "pt-BR": "Responsável pela documentação",
      },
    );

    expectTerms(["pipeline.lifecycle.template.copy_documentator"], {
      en: "Copy Documentation owner — discover → claim → llm → label",
      es: "Copiar Responsable de documentación — discover → claim → llm → etiqueta",
      "pt-BR":
        "Copiar Responsável pela documentação: discover → claim → llm → label",
    });

    const tooltipTermByLocale: Record<Locale, string> = {
      en: "documentation owner",
      es: "responsable de documentación",
      "pt-BR": "responsável pela documentação",
    };

    for (const [locale, catalog] of Object.entries(catalogs) as [
      Locale,
      Catalog,
    ][]) {
      expect(
        readCatalogPath(catalog, "teams.pipelineTooltip"),
        `${locale}:teams.pipelineTooltip`,
      ).toEqual(expect.stringContaining(tooltipTermByLocale[locale]));
    }
  });

  it("keeps pipeline stages distinct from lifecycle steps", () => {
    expectTerms(["prompts.fields.stage"], {
      en: "Stage",
      es: "Etapa",
      "pt-BR": "Etapa",
    });

    expectTerms(["pipelineBuilder.stages"], {
      en: "Stages",
      es: "Etapas",
      "pt-BR": "Etapas",
    });

    expectTerms(
      ["pipelineBuilder.lifecycle.kinds.llm.params.stage.label"],
      {
        en: "Stage",
        es: "Etapa",
        "pt-BR": "Etapa",
      },
    );

    expectTerms(["pipelineGraph.canvas.inspectorStep"], {
      en: "Step",
      es: "Paso",
      "pt-BR": "Passo",
    });

    expectTerms(["pipelineGraph.canvas.inspectorRoleSteps"], {
      en: "Lifecycle steps",
      es: "Pasos del ciclo de vida",
      "pt-BR": "Passos do ciclo de vida",
    });

    expectTerms(["pipeline.lifecycle.step.add"], {
      en: "Add step",
      es: "Agregar paso",
      "pt-BR": "Adicionar passo",
    });

    expectTerms(["pipeline.lifecycle.role.stepsCount_one"], {
      en: "{{count}} step",
      es: "{{count}} paso",
      "pt-BR": "{{count}} passo",
    });

    expectTerms(["pipeline.lifecycle.role.stepsCount_other"], {
      en: "{{count}} steps",
      es: "{{count}} pasos",
      "pt-BR": "{{count}} passos",
    });

    expectTerms(["rolePanel.stepCount_one"], {
      en: "{{count}} lifecycle step",
      es: "{{count}} paso del ciclo de vida",
      "pt-BR": "{{count}} passo do ciclo de vida",
    });

    expectTerms(["pipeline.lifecycle.step.nameLabel"], {
      en: "Step name",
      es: "Nombre del paso",
      "pt-BR": "Nome do passo",
    });

    expectTerms(["pipeline.lifecycle.next.label"], {
      en: "Next step",
      es: "Siguiente paso",
      "pt-BR": "Próximo passo",
    });

    expectTerms(["a11y.mcpOnboarding.steps"], {
      en: "Wizard steps",
      es: "Pasos del asistente",
      "pt-BR": "Passos do assistente",
    });
  });

  it("retains the approved core product nouns", () => {
    expectTerms(["activity.entityTypes.card"], {
      en: "Card",
      es: "Tarjeta",
      "pt-BR": "Cartão",
    });

    expectTerms(["teams.role"], {
      en: "Role",
      es: "Rol",
      "pt-BR": "Função",
    });

    expectTerms(["notes.origin.agent"], {
      en: "Runner",
      es: "Runner",
      "pt-BR": "Runner",
    });

    expectTerms(["notifications.actor.agent"], {
      en: "An agent",
      es: "Un agente",
      "pt-BR": "Um agente",
    });

    expectTerms(["kanban.filterBar.filter.labels"], {
      en: "Labels",
      es: "Etiquetas",
      "pt-BR": "Rótulos",
    });

    expectTerms(["definitions.sections.stakeholders"], {
      en: "Stakeholders",
      es: "Partes interesadas",
      "pt-BR": "Partes interessadas",
    });

    expectTerms(["pipelineBuilder.lifecycle.kinds.claim.title"], {
      en: "Claim",
      es: "Tomar",
      "pt-BR": "Assumir",
    });

    expectTerms(
      ["pipelineBuilder.lifecycle.kinds.git_setup.params.branch_prefix.label"],
      {
        en: "Branch prefix",
        es: "Prefijo de rama",
        "pt-BR": "Prefixo da branch",
      },
    );
  });

  it("uses approved terms in narrative product copy", () => {
    const expectedFragments: Record<
      Locale,
      Record<"stakeholder" | "claim" | "step" | "documentationOwner", string>
    > = {
      en: {
        stakeholder: "stakeholders",
        claim: "Claims a card",
        step: "first step",
        documentationOwner: "documentation owner",
      },
      es: {
        stakeholder: "partes interesadas",
        claim: "Toma una tarjeta",
        step: "primer paso",
        documentationOwner: "responsable",
      },
      "pt-BR": {
        stakeholder: "partes interessadas",
        claim: "Assume um cartão",
        step: "primeiro passo",
        documentationOwner: "responsáv",
      },
    };

    const documentationOwnerPaths = [
      "ui.tooltips.columnType.examples.3",
      "ui.tooltips.cardTypeFeature.summary",
      "ui.tooltips.promptStructuredOutput.examples.2",
      "ui.tooltips.execution.role.examples.1",
      "ui.tooltips.kanban.participantRole.rows.1.value",
    ];

    for (const [locale, catalog] of Object.entries(catalogs) as [
      Locale,
      Catalog,
    ][]) {
      const expected = expectedFragments[locale];
      expect(
        readCatalogPath(catalog, "definitions.description"),
        `${locale}:definitions.description`,
      ).toEqual(expect.stringContaining(expected.stakeholder));
      expect(
        readCatalogPath(catalog, "rolesGlossary.roles.implementer.headline"),
        `${locale}:rolesGlossary.roles.implementer.headline`,
      ).toEqual(expect.stringContaining(expected.claim));
      expect(
        readCatalogPath(catalog, "lifecycleKindCatalog.discover.whenToUse"),
        `${locale}:lifecycleKindCatalog.discover.whenToUse`,
      ).toEqual(expect.stringContaining(expected.step));

      for (const path of documentationOwnerPaths) {
        expect(readCatalogPath(catalog, path), `${locale}:${path}`).toEqual(
          expect.stringContaining(expected.documentationOwner),
        );
      }
    }
  });

  it("does not leak legacy English product nouns into Spanish MCP onboarding", () => {
    const paths = [
      "mcpOnboarding.subtitle",
      "mcpOnboarding.introHeading",
      "mcpOnboarding.introBody",
      "mcpOnboarding.positioningMcpBody",
      "mcpOnboarding.positioningRunnersBody",
      "mcpOnboarding.positioningCoexistence",
      "mcpOnboarding.verifyAlreadyConnected",
      "mcpOnboarding.verifyNextContext",
    ];

    for (const path of paths) {
      expect(String(readCatalogPath(es, path)), `es:${path}`).not.toMatch(
        /\b(?:workspace|boards?|cards?)\b/i,
      );
    }
  });

});
