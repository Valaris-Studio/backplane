// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import type { Activity } from "@/types/activity";
import {
  ACTIVITY_MESSAGE_KEYS,
  resolveActivityMessage,
} from "../resolve-activity-message";
import activityMessageContract from "../../activity-message-contract.json";

type ContractKey = keyof typeof activityMessageContract;

const CONTRACT_KEYS = Object.keys(activityMessageContract) as ContractKey[];

function resourceKeys(key: ContractKey): string[] {
  const entry = activityMessageContract[key] as {
    params: Record<string, string>;
    pluralParam?: string;
  };
  return entry.pluralParam ? [`${key}_one`, `${key}_other`] : [key];
}

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "activity-1",
    workspace_id: "workspace-1",
    board_id: "board-1",
    actor_id: "user-1",
    actor_name: "Ada",
    actor_email: "ada@example.com",
    agent_id: null,
    entity_type: "card",
    entity_id: "card-1",
    action: "moved",
    summary: "legacy summary — preserve exactly",
    message_key: "activity.card.moved",
    message_params: {
      card_title: "Launch",
      from_column_name: "Backlog",
      from_column_known: true,
      to_column_name: "Review",
    },
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-08-07T12:00:00Z",
    ...overrides,
  };
}

// Non-English catalogs load on demand, so this cross-locale contract has to
// pull them in before reading resources off the instance.
beforeAll(async () => {
  for (const locale of ["es", "pt-BR"] as const) {
    await i18n.changeLanguage(locale);
  }
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("activity message catalog contract", () => {
  it("derives the resolver inventory from the shared activity contract", () => {
    expect(ACTIVITY_MESSAGE_KEYS).toEqual(CONTRACT_KEYS);
  });

  it.each(["en", "es", "pt-BR"] as const)(
    "defines every structured activity key in %s without locale fallback",
    (locale) => {
      for (const key of CONTRACT_KEYS) {
        for (const resourceKey of resourceKeys(key)) {
          expect(
            i18n.getResource(locale, "translation", resourceKey),
            `${locale}: ${resourceKey}`,
          ).toEqual(expect.any(String));
        }
      }
    },
  );

  it("keeps interpolation placeholders aligned across all locales", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
        .flatMap((match) => (match[1] ? [match[1]] : []))
        .sort();

    for (const key of CONTRACT_KEYS) {
      const allowedParams = Object.keys(activityMessageContract[key].params);
      for (const resourceKey of resourceKeys(key)) {
        const en = i18n.getResource("en", "translation", resourceKey) as string;
        const es = i18n.getResource("es", "translation", resourceKey) as string;
        const ptBr = i18n.getResource(
          "pt-BR",
          "translation",
          resourceKey,
        ) as string;
        expect(placeholders(es), `es: ${resourceKey}`).toEqual(placeholders(en));
        expect(placeholders(ptBr), `pt-BR: ${resourceKey}`).toEqual(
          placeholders(en),
        );
        expect(
          placeholders(en).every((placeholder) =>
            allowedParams.includes(placeholder),
          ),
          `${resourceKey}: catalog placeholders must come from the shared contract`,
        ).toBe(true);
      }
    }
  });
});

describe("resolveActivityMessage", () => {
  it.each([
    ["en", "moved 'Launch' from 'Backlog' to 'Review'"],
    ["es", "movió 'Launch' de 'Backlog' a 'Review'"],
    ["pt-BR", "moveu 'Launch' de 'Backlog' para 'Review'"],
  ] as const)("interpolates known messages in %s", async (locale, expected) => {
    await i18n.changeLanguage(locale);

    expect(resolveActivityMessage(activity(), i18n.t.bind(i18n))).toBe(expected);
  });

  it.each([
    ["en", "permanently deleted runner 'Seba'"],
    ["es", "eliminó permanentemente el runner 'Seba'"],
    ["pt-BR", "excluiu permanentemente o runner 'Seba'"],
  ] as const)(
    "localizes agent lifecycle activity in %s",
    async (locale, expected) => {
      await i18n.changeLanguage(locale);

      expect(
        resolveActivityMessage(
          activity({
            entity_type: "agent",
            action: "deleted",
            message_key: "activity.agent.hard_deleted",
            message_params: { agent_name: "Seba" },
          }),
          i18n.t.bind(i18n),
        ),
      ).toBe(expected);
    },
  );

  it("preserves user-authored interpolation values byte-for-byte", async () => {
    await i18n.changeLanguage("pt-BR");
    const cardTitle = "Fix --raw <script> & não traduzir";

    const resolved = resolveActivityMessage(
      activity({
        message_key: "activity.card.created",
        message_params: { card_title: cardTitle },
      }),
      i18n.t.bind(i18n),
    );

    expect(resolved).toContain(cardTitle);
  });

  it("does not let unexpected params override i18next options", async () => {
    await i18n.changeLanguage("pt-BR");

    expect(
      resolveActivityMessage(
        activity({
          message_key: "activity.card.created",
          message_params: {
            card_title: "Launch",
            lng: "es",
            defaultValue: "INJECTED",
          },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe("criou o cartão 'Launch'");
  });

  it.each([
    [null, "missing params must preserve the legacy summary EXACT"],
    [{}, "missing required params must preserve the legacy summary EXACT"],
    [
      { card_title: 42 },
      "wrong param types must preserve the legacy summary EXACT",
    ],
  ] as const)(
    "falls back exactly to summary when a known key has invalid params: %j",
    (messageParams, summary) => {
      expect(
        resolveActivityMessage(
          activity({
            message_key: "activity.card.created",
            message_params: messageParams,
            summary,
          }),
          i18n.t.bind(i18n),
        ),
      ).toBe(summary);
    },
  );

  it.each([
    [
      "activity.card.bulk_created",
      { card_count: 1 },
      "created 1 card in bulk",
    ],
    [
      "activity.card.bulk_created",
      { card_count: 12_345 },
      "created 12,345 cards in bulk",
    ],
    [
      "activity.card.pipeline_role_participants_removed",
      { card_title: "Launch", pipeline_role: "reviewer", participant_count: 1 },
      "removed 1 pipeline participant from 'Launch' (role: reviewer)",
    ],
    [
      "activity.card.pipeline_role_participants_removed",
      {
        card_title: "Launch",
        pipeline_role: "reviewer",
        participant_count: 12_345,
      },
      "removed 12,345 pipeline participants from 'Launch' (role: reviewer)",
    ],
    [
      "activity.card.dependencies_replaced",
      { dependency_count: 1 },
      "replaced 1 card dependency",
    ],
    [
      "activity.card.dependencies_replaced",
      { dependency_count: 12_345 },
      "replaced 12,345 card dependencies",
    ],
    [
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 1,
        execution_action: "implementation",
        label: "blocked",
      },
      "parked 'Launch': 1 'implementation' execution produced no PR or commit (completed-no-commit loop). Re-scope the card to be runnable and remove 'blocked' to resume",
    ],
    [
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 12_345,
        execution_action: "implementation",
        label: "blocked",
      },
      "parked 'Launch': 12,345 'implementation' executions produced no PR or commit (completed-no-commit loop). Re-scope the card to be runnable and remove 'blocked' to resume",
    ],
  ] as const)(
    "selects English singular/plural copy and formats numbers for %s",
    (messageKey, messageParams, expected) => {
      expect(
        resolveActivityMessage(
          activity({ message_key: messageKey, message_params: messageParams }),
          i18n.t.bind(i18n),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [
      "es",
      "activity.card.bulk_created",
      { card_count: 12_345 },
      "creó 12.345 tarjetas en lote",
    ],
    [
      "pt-BR",
      "activity.card.bulk_created",
      { card_count: 12_345 },
      "criou 12.345 cartões em lote",
    ],
    [
      "es",
      "activity.card.pipeline_role_participants_removed",
      { card_title: "Launch", pipeline_role: "reviewer", participant_count: 1 },
      "eliminó 1 participante del pipeline de 'Launch' (rol: reviewer)",
    ],
    [
      "pt-BR",
      "activity.card.pipeline_role_participants_removed",
      { card_title: "Launch", pipeline_role: "reviewer", participant_count: 1 },
      "removeu 1 participante do pipeline de 'Launch' (função: reviewer)",
    ],
    [
      "es",
      "activity.card.dependencies_replaced",
      { dependency_count: 1 },
      "reemplazó 1 dependencia de la tarjeta",
    ],
    [
      "pt-BR",
      "activity.card.dependencies_replaced",
      { dependency_count: 1 },
      "substituiu 1 dependência do cartão",
    ],
    [
      "es",
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 1,
        execution_action: "implementation",
        label: "blocked",
      },
      "estacionó 'Launch': 1 ejecución de 'implementation' no produjo ningún PR ni commit (ciclo completed-no-commit). Ajusta el alcance de la tarjeta para que sea ejecutable y elimina 'blocked' para reanudarla",
    ],
    [
      "pt-BR",
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 1,
        execution_action: "implementation",
        label: "blocked",
      },
      "estacionou 'Launch': 1 execução de 'implementation' não gerou PR nem commit (ciclo completed-no-commit). Redefina o escopo do cartão para que ele possa ser executado e remova 'blocked' para retomá-lo",
    ],
    [
      "es",
      "activity.card.bulk_created",
      { card_count: 1_000_000 },
      "creó 1.000.000 tarjetas en lote",
    ],
    [
      "pt-BR",
      "activity.card.bulk_created",
      { card_count: 1_000_000 },
      "criou 1.000.000 cartões em lote",
    ],
    [
      "es",
      "activity.card.pipeline_role_participants_removed",
      {
        card_title: "Launch",
        pipeline_role: "reviewer",
        participant_count: 1_000_000,
      },
      "eliminó 1.000.000 participantes del pipeline de 'Launch' (rol: reviewer)",
    ],
    [
      "pt-BR",
      "activity.card.pipeline_role_participants_removed",
      {
        card_title: "Launch",
        pipeline_role: "reviewer",
        participant_count: 1_000_000,
      },
      "removeu 1.000.000 participantes do pipeline de 'Launch' (função: reviewer)",
    ],
    [
      "es",
      "activity.card.dependencies_replaced",
      { dependency_count: 1_000_000 },
      "reemplazó 1.000.000 dependencias de la tarjeta",
    ],
    [
      "pt-BR",
      "activity.card.dependencies_replaced",
      { dependency_count: 1_000_000 },
      "substituiu 1.000.000 dependências do cartão",
    ],
    [
      "es",
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 1_000_000,
        execution_action: "implementation",
        label: "blocked",
      },
      "estacionó 'Launch': 1.000.000 ejecuciones de 'implementation' no produjeron ningún PR ni commit (ciclo completed-no-commit). Ajusta el alcance de la tarjeta para que sea ejecutable y elimina 'blocked' para reanudarla",
    ],
    [
      "pt-BR",
      "activity.card.parked_no_progress",
      {
        card_title: "Launch",
        attempt_count: 1_000_000,
        execution_action: "implementation",
        label: "blocked",
      },
      "estacionou 'Launch': 1.000.000 execuções de 'implementation' não geraram PR nem commit (ciclo completed-no-commit). Redefina o escopo do cartão para que ele possa ser executado e remova 'blocked' para retomá-lo",
    ],
  ] as const)(
    "selects localized singular/plural copy and regional numbers in %s",
    async (locale, messageKey, messageParams, expected) => {
      await i18n.changeLanguage(locale);
      expect(
        resolveActivityMessage(
          activity({ message_key: messageKey, message_params: messageParams }),
          i18n.t.bind(i18n),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [
      "en",
      "activity.card.parked_unresolved_git_repo",
      { card_title: "Launch", git_repo_slug: "ghost", label: "blocked" },
      "parked card 'Launch': git_repo_slug 'ghost' matches no repository on this board. Fix the card's git_repo_slug and remove the 'blocked' label to resume",
    ],
    [
      "es",
      "activity.card.parked_unresolved_git_repo",
      { card_title: "Launch", git_repo_slug: "ghost", label: "blocked" },
      "estacionó la tarjeta 'Launch': el git_repo_slug 'ghost' no coincide con ningún repositorio de este tablero. Corrige el git_repo_slug de la tarjeta y elimina la etiqueta 'blocked' para reanudarla",
    ],
    [
      "pt-BR",
      "activity.card.parked_unresolved_git_repo",
      { card_title: "Launch", git_repo_slug: "ghost", label: "blocked" },
      "estacionou o cartão 'Launch': o git_repo_slug 'ghost' não corresponde a nenhum repositório deste quadro. Corrija o git_repo_slug do cartão e remova o rótulo 'blocked' para retomá-lo",
    ],
    [
      "en",
      "activity.card.unknown_git_repo_slug_dropped",
      { card_title: "Launch", git_repo_slug: "ghost" },
      "dropped unknown git_repo_slug 'ghost' on card 'Launch': it matches no repository on this board, so the board-primary repository default applies",
    ],
    [
      "es",
      "activity.card.unknown_git_repo_slug_dropped",
      { card_title: "Launch", git_repo_slug: "ghost" },
      "descartó el git_repo_slug desconocido 'ghost' de la tarjeta 'Launch': no coincide con ningún repositorio de este tablero, por lo que se aplica el repositorio board-primary predeterminado",
    ],
    [
      "pt-BR",
      "activity.card.unknown_git_repo_slug_dropped",
      { card_title: "Launch", git_repo_slug: "ghost" },
      "descartou o git_repo_slug desconhecido 'ghost' do cartão 'Launch': ele não corresponde a nenhum repositório deste quadro, portanto o repositório board-primary padrão será usado",
    ],
    [
      "en",
      "activity.card.ui_validation_label_applied",
      { card_title: "Launch", label: "needs-ui-validation" },
      "applied label 'needs-ui-validation' to card 'Launch' for approve-verdict routing",
    ],
    [
      "es",
      "activity.card.ui_validation_label_applied",
      { card_title: "Launch", label: "needs-ui-validation" },
      "aplicó la etiqueta 'needs-ui-validation' a la tarjeta 'Launch' para el enrutamiento approve-verdict",
    ],
    [
      "pt-BR",
      "activity.card.ui_validation_label_applied",
      { card_title: "Launch", label: "needs-ui-validation" },
      "aplicou o rótulo 'needs-ui-validation' ao cartão 'Launch' para o roteamento approve-verdict",
    ],
  ] as const)(
    "preserves the full operational meaning in %s for %s",
    async (locale, messageKey, messageParams, expected) => {
      await i18n.changeLanguage(locale);
      expect(
        resolveActivityMessage(
          activity({ message_key: messageKey, message_params: messageParams }),
          i18n.t.bind(i18n),
        ),
      ).toBe(expected);
    },
  );

  it("uses a localized unknown-column label instead of interpolating null", async () => {
    await i18n.changeLanguage("es");

    expect(
      resolveActivityMessage(
        activity({
          message_params: {
            card_title: "Launch",
            from_column_name: null,
            from_column_known: false,
            to_column_name: "Review",
          },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe("movió 'Launch' de 'Desconocida' a 'Review'");
  });

  it("formats field token arrays without translating their contents", async () => {
    await i18n.changeLanguage("pt-BR");

    expect(
      resolveActivityMessage(
        activity({
          message_key: "activity.card.updated",
          message_params: {
            card_title: "Launch",
            fields: ["description", "due_date"],
          },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe("atualizou 'Launch' (description, due_date)");
  });

  it("falls back exactly to summary for legacy records", () => {
    const summary = "  Legacy -- summary <raw>  ";
    expect(
      resolveActivityMessage(
        activity({ message_key: null, message_params: null, summary }),
        i18n.t.bind(i18n),
      ),
    ).toBe(summary);
  });

  it("falls back exactly to summary for unknown keys", () => {
    const summary = "unknown-key summary must stay EXACT";
    expect(
      resolveActivityMessage(
        activity({
          message_key: "activity.card.future_operation",
          message_params: { card_title: "Launch" },
          summary,
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe(summary);
  });
});

describe("dependency activity rows name the target card, not its id", () => {
  const DEPENDS_ON_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const DEPENDENCY_KEYS = [
    "activity.card.dependency_added",
    "activity.card.dependency_removed",
  ] as const;

  it.each(DEPENDENCY_KEYS)(
    "renders the dependency target's title for %s in en",
    async (messageKey) => {
      await i18n.changeLanguage("en");

      const resolved = resolveActivityMessage(
        activity({
          message_key: messageKey,
          message_params: {
            depends_on_card_id: DEPENDS_ON_ID,
            depends_on_title: "Ship billing",
          },
          summary: "legacy summary must not win here",
        }),
        i18n.t.bind(i18n),
      );

      expect(resolved).toContain("Ship billing");
      expect(resolved).not.toContain(DEPENDS_ON_ID);
      expect(resolved).not.toBe("legacy summary must not win here");
    },
  );

  // The contract has no optional-param type (every declared param is
  // required), so a pre-title row written before this change cannot resolve
  // through the catalog — it must keep its id-bearing summary byte-for-byte.
  it.each(DEPENDENCY_KEYS)(
    "falls back exactly to summary for a legacy %s row lacking the title",
    async (messageKey) => {
      await i18n.changeLanguage("en");
      // Deliberately not the catalog's own wording: today the resolver still
      // renders the id-only catalog string, and a matching summary would mask
      // that.
      const summary = `LEGACY ROW -- depends on ${DEPENDS_ON_ID} -- keep EXACT`;

      expect(
        resolveActivityMessage(
          activity({
            message_key: messageKey,
            message_params: { depends_on_card_id: DEPENDS_ON_ID },
            summary,
          }),
          i18n.t.bind(i18n),
        ),
      ).toBe(summary);
    },
  );

  it.each([
    ["en", "activity.card.dependency_added"],
    ["en", "activity.card.dependency_removed"],
    ["es", "activity.card.dependency_added"],
    ["es", "activity.card.dependency_removed"],
    ["pt-BR", "activity.card.dependency_added"],
    ["pt-BR", "activity.card.dependency_removed"],
  ] as const)(
    "%s catalog interpolates the title, not the card id, for %s",
    (locale, messageKey) => {
      const value = i18n.getResource(locale, "translation", messageKey);

      expect(value).toContain("{{depends_on_title}}");
      expect(value).not.toContain("{{depends_on_card_id}}");
    },
  );
});
