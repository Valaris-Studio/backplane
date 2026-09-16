// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

// A missed es key ships silently (i18next falls back to English). This guards
// the mcpOnboarding namespace: for every user-facing sample key the es value
// must exist AND differ from en, i.e. be hand-written Spanish.
//
// Deliberately excluded from the "must differ" rule:
//  - product nouns that stay English by convention (workspace, board, runner,
//    API key, MCP) when they are the WHOLE string;
//  - `positioningRunnersTitle` ("Runners") and `stepKey` ("API key"), product
//    nouns that stay English by the onboarding namespace's convention;
//  - the agent handoff message and the mcpServers JSON, which are not in the
//    locale files at all — they are addressed to an agent, not to the user, and
//    are composed in English in agent-handoff.ts by design.
const IDENTICAL_BY_DESIGN = ["positioningRunnersTitle", "stepKey"];

const SAMPLE_KEYS = [
  "title",
  "subtitle",
  "stepIntro",
  "stepPositioning",
  "stepKey",
  "stepConnect",
  "stepVerify",
  "next",
  "back",
  // Step 1
  "introHeading",
  "introBody",
  "introPromise",
  // Step 2
  "positioningIntro",
  "positioningMcpTitle",
  "positioningMcpBody",
  "positioningRunnersTitle",
  "positioningRunnersBody",
  "positioningCoexistence",
  "positioningNoRunnerNeeded",
  "positioningDocsLink",
  // Step 3
  "keyIntro",
  "keyIdentityHint",
  "keyNameLabel",
  "keyCreateAction",
  "keyRevealWarning",
  "keyExistingHeading",
  "keyExistingHint",
  "keyCreateNewAction",
  "keyCreateError",
  "keyRetryAction",
  // Step 4
  "connectIntro",
  "connectMessageLabel",
  "connectSubstituteHint",
  "connectAdvanced",
  "connectAdvancedIntro",
  "connectJsonLabel",
  "connectEnvHeading",
  "connectEnvApiUrl",
  "connectEnvApiKey",
  "connectEnvAgentEmail",
  "connectGitInstallLabel",
  "connectRequired",
  "connectOptional",
  // Close guard
  "closeGuardTitle",
  "closeGuardBody",
  "closeGuardConfirm",
  "closeGuardCancel",
  // Step 5
  "verifyConnectAnother",
  "verifyWaitingTitle",
  "verifyWaitingBody",
  "verifyTroubleshootingTitle",
  "verifyHintApiUrl",
  "verifyHintApiKey",
  "verifyHintUvx",
  "verifyKeepWaiting",
  "verifySkip",
  "verifyDocsLink",
  // Dashboard activation callout
  "calloutHeadline",
  "calloutBody",
  "calloutAction",
];

function lookup(locale: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      locale,
    );
}

describe("mcpOnboarding locales — es is hand-written, never a silent en fallback", () => {
  const enSection = (en as Record<string, unknown>).mcpOnboarding as Record<
    string,
    unknown
  >;
  const esSection = (es as Record<string, unknown>).mcpOnboarding as Record<
    string,
    unknown
  >;

  it("has an mcpOnboarding namespace in both locales", () => {
    expect(enSection).toBeDefined();
    expect(esSection).toBeDefined();
  });

  it.each(SAMPLE_KEYS)("mcpOnboarding.%s exists in both locales", (key) => {
    const enValue = lookup(enSection, key);
    const esValue = lookup(esSection, key);

    expect(enValue, `en missing mcpOnboarding.${key}`).toBeTypeOf("string");
    expect((enValue as string).length).toBeGreaterThan(0);
    expect(esValue, `es missing mcpOnboarding.${key}`).toBeTypeOf("string");
    expect((esValue as string).length).toBeGreaterThan(0);
  });

  it.each(SAMPLE_KEYS.filter((k) => !IDENTICAL_BY_DESIGN.includes(k)))(
    "mcpOnboarding.%s is translated, not copied from en",
    (key) => {
      expect(
        lookup(esSection, key),
        `es value for mcpOnboarding.${key} mirrors en`,
      ).not.toBe(lookup(enSection, key));
    },
  );

  // These were written for UI that never shipped (the illustration is
  // aria-hidden and draws no text; the picker heading covers the pick action).
  // Assert they stay gone rather than accreting as untranslated dead weight.
  // `verifyPlaceholder` joins them: it was the placeholder step-5 body's copy,
  // retired when the real verify pane landed with its own waiting strings.
  it.each([
    "keyPickExistingAction",
    "introDiagramAgent",
    "introDiagramTools",
    "introDiagramBoard",
    "verifyPlaceholder",
  ])(
    "does not carry the unused key %s",
    (key) => {
      expect(lookup(enSection, key)).toBeUndefined();
      expect(lookup(esSection, key)).toBeUndefined();
    },
  );

  it("keeps copy free of exclamation marks in both locales", () => {
    for (const key of SAMPLE_KEYS) {
      expect(String(lookup(enSection, key))).not.toContain("!");
      expect(String(lookup(esSection, key))).not.toContain("¡");
      expect(String(lookup(esSection, key))).not.toContain("!");
    }
  });

  it("carries the wizard's a11y labels in both locales", () => {
    const enA11y = lookup(en as Record<string, unknown>, "a11y.mcpOnboarding");
    const esA11y = lookup(es as Record<string, unknown>, "a11y.mcpOnboarding");
    expect(enA11y).toBeTypeOf("object");
    expect(esA11y).toBeTypeOf("object");
    for (const key of [
      "steps",
      "copyApiKey",
      "copyAgentMessage",
      "copyJson",
      "copyToolName",
    ]) {
      expect(
        lookup(enA11y as Record<string, unknown>, key),
        `en missing a11y.mcpOnboarding.${key}`,
      ).toBeTypeOf("string");
      expect(
        lookup(esA11y as Record<string, unknown>, key),
        `es missing a11y.mcpOnboarding.${key}`,
      ).toBeTypeOf("string");
    }
  });
});

// --- MCP #2: toolset intent picker keys -------------------------------------
//
// The block above samples es only. The picker's keys are pinned across ALL
// three locales here: a missing es or pt-BR value ships as silent English
// fallback on the wizard's money step. The middle preset now describes
// interactive loop preparation, so its full label must also be translated.
const INTENT_PICKER_KEYS = [
  "connectIntentHeading",
  "connectIntentInteractive",
  "connectIntentInteractiveBody",
  "connectIntentRunner",
  "connectIntentRunnerBody",
  "connectIntentEverything",
  "connectIntentEverythingBody",
  "connectEnvToolsets",
] as const;

const INTENT_LOCALES = {
  en: (en as Record<string, unknown>).mcpOnboarding as Record<string, unknown>,
  es: (es as Record<string, unknown>).mcpOnboarding as Record<string, unknown>,
  "pt-BR": (ptBR as Record<string, unknown>).mcpOnboarding as Record<string, unknown>,
} as const;

describe("mcpOnboarding locales — toolset intent picker keys exist in en/es/pt-BR", () => {
  it.each(INTENT_PICKER_KEYS)("mcpOnboarding.%s is a non-empty string in every locale", (key) => {
    for (const [locale, section] of Object.entries(INTENT_LOCALES)) {
      const value = lookup(section, key);
      expect(value, `${locale} missing mcpOnboarding.${key}`).toBeTypeOf("string");
      expect((value as string).trim().length, `${locale} mcpOnboarding.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(INTENT_PICKER_KEYS)("mcpOnboarding.%s is hand-written in es and pt-BR, not copied from en", (key) => {
    const enValue = lookup(INTENT_LOCALES.en, key);
    expect(lookup(INTENT_LOCALES.es, key), `es mirrors en for mcpOnboarding.${key}`).not.toBe(enValue);
    expect(lookup(INTENT_LOCALES["pt-BR"], key), `pt-BR mirrors en for mcpOnboarding.${key}`).not.toBe(enValue);
  });

  it("keeps the picker copy free of exclamation marks in every locale", () => {
    for (const key of INTENT_PICKER_KEYS) {
      for (const section of Object.values(INTENT_LOCALES)) {
        expect(String(lookup(section, key))).not.toContain("!");
        expect(String(lookup(section, key))).not.toContain("¡");
      }
    }
  });
});

// --- MCP #3: "skills that fit this hand" keys -------------------------------
//
// The body must tell the truth about the interactive hand: it loads the
// declared toolsets' GROUPS but trims a few admin and destructive tools from
// them, and a board's loop grant is checked tool by tool. Copy that claims the
// toolsets are "fully loaded" is the finding this pin guards against.
const SKILLS_FIT_KEYS = ["connectSkillsHeading", "connectSkillsBody"] as const;

describe("mcpOnboarding locales — skills-that-fit keys exist and tell the truth in en/es/pt-BR", () => {
  it.each(SKILLS_FIT_KEYS)("mcpOnboarding.%s is hand-written in every locale", (key) => {
    const enValue = lookup(INTENT_LOCALES.en, key);
    expect(enValue, `en missing mcpOnboarding.${key}`).toBeTypeOf("string");
    for (const locale of ["es", "pt-BR"] as const) {
      const value = lookup(INTENT_LOCALES[locale], key);
      expect(value, `${locale} missing mcpOnboarding.${key}`).toBeTypeOf("string");
      expect((value as string).trim().length, `${locale} mcpOnboarding.${key} is empty`).toBeGreaterThan(0);
      expect(value, `${locale} mirrors en for mcpOnboarding.${key}`).not.toBe(enValue);
    }
  });

  it("names the interactive hand's admin/destructive trim and the tool-by-tool loop grant", () => {
    for (const [locale, section] of Object.entries(INTENT_LOCALES)) {
      const body = String(lookup(section, "connectSkillsBody"));
      expect(body, `${locale} body omits the admin trim`).toMatch(/admin/i);
      expect(body, `${locale} body omits the destructive trim`).toMatch(/destru/i);
      expect(body, `${locale} body omits the loop grant`).toMatch(/loop|bucle/i);
    }
  });

  it("keeps the skills-that-fit copy free of exclamation marks and digits in every locale", () => {
    for (const key of SKILLS_FIT_KEYS) {
      for (const [locale, section] of Object.entries(INTENT_LOCALES)) {
        const value = String(lookup(section, key));
        expect(value, `${locale} mcpOnboarding.${key}`).not.toContain("!");
        expect(value, `${locale} mcpOnboarding.${key}`).not.toContain("¡");
        expect(value, `${locale} mcpOnboarding.${key} glues a count to the copy`).not.toMatch(/\d/);
      }
    }
  });
});


it("describes the middle preset as preparing loops with a human's agent", () => {
  expect(en.mcpOnboarding.connectIntentInteractive).toBe("Everyday project work");
  expect(en.mcpOnboarding.connectIntentRunner).toBe("Loops and runners");
  expect(en.mcpOnboarding.connectIntentRunnerBody).toMatch(/prepar|manag/i);
  expect(en.mcpOnboarding.connectIntentRunnerBody).not.toMatch(/loads the whole surface|only narrowing/i);
});

const VERIFICATION_KEYS = [
  "verifyAuthObservedTitle",
  "verifyAuthObservedBody",
  "verifyAuthHistoricalBody",
  "verifyToolCheckPending",
  "verifyCheckLabel",
  "verifyCopyCheck",
  "verifyAgentResultLabel",
  "verifyResultPending",
  "verifyResultSuccess",
  "verifyResultReported",
  "verifyResultMissingTools",
  "verifyResultAuth",
  "verifyResultNetwork",
  "verifyResultVersionAllowlist",
  "verifyRecoveryMissingTools",
  "verifyRecoveryAuth",
  "verifyRecoveryNetwork",
  "verifyRecoveryVersionAllowlist",
] as const;

describe("mcpOnboarding locales — honest verification and recovery", () => {
  it.each(VERIFICATION_KEYS)("translates %s in every registered locale", (key) => {
    const english = lookup(INTENT_LOCALES.en, key);
    expect(english, `en missing ${key}`).toBeTypeOf("string");
    for (const [locale, section] of Object.entries(INTENT_LOCALES)) {
      const value = lookup(section, key);
      expect(value, `${locale} missing ${key}`).toBeTypeOf("string");
      expect(String(value).trim()).not.toBe("");
      if (locale !== "en") expect(value, `${locale} must translate ${key}`).not.toBe(english);
    }
  });

  it("preserves recovery's exact technical identifiers in every locale", () => {
    for (const [locale, section] of Object.entries(INTENT_LOCALES)) {
      const recovery = String(lookup(section, "verifyRecoveryMissingTools"));
      for (const term of ["restart_env", "enable_toolsets", "stdio", "HTTP"]) {
        expect(recovery, `${locale} recovery omits ${term}`).toContain(term);
      }
    }
  });

  it.each([
    ["en", /prove the connection works/i],
    ["es", /demostr[^.]*conexi[oó]n funciona/i],
    ["pt-BR", /comprov[^.]*conex[aã]o funciona/i],
  ] as const)("does not overpromise selected-tool verification in the %s connect intro", (locale, overclaim) => {
    expect(INTENT_LOCALES[locale].connectIntro).not.toMatch(overclaim);
  });
});
