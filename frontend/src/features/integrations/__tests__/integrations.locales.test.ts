// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

// A missed es key ships silently (i18next falls back to English). This guards
// the integrations namespace — the git-credential surface, where an
// untranslated string lands in front of a workspace owner mid-setup.
//
// Deliberately excluded from the "must differ" rule: product/protocol nouns
// that stay English in both locales by convention.
const IDENTICAL_BY_DESIGN = [
  "connectGitHub",
  "authKind.oauth",
  "authKind.pat",
  "pat.scopeGuidance.bitbucket",
];

const SAMPLE_KEYS = [
  "title",
  "subtitle",
  "connectGitHub",
  "notConfiguredTooltip",
  "deleteConnection",
  "connectedBy",
  // Teaching empty state
  "connectionsEmptyTitle",
  "connectionsEmptyBody",
  "connectionsEmptyHint",
  // Row controls
  "addToken",
  "verify",
  "verifying",
  "checksTitle",
  "authKind.oauth",
  "authKind.pat",
  "health.healthy",
  "health.failing",
  "health.unverified",
  "checkName.identity",
  "checkName.scopes",
  "checkName.ci-read",
  // Repository picker filter
  "filterRepositoriesPlaceholder",
  "noMatches",
  "noMatchesLoadMore",
  // PAT dialog
  "pat.title",
  "pat.subtitle",
  "pat.providerLabel",
  "pat.tokenLabel",
  "pat.tokenPlaceholder",
  "pat.tokenHint",
  "pat.baseUrlLabelRequired",
  "pat.baseUrlLabelOptional",
  "pat.baseUrlHintRequired",
  "pat.baseUrlHintOptional",
  "pat.scopesTitle",
  "pat.githubPermissions.title",
  "pat.githubPermissions.repositorySelection",
  "pat.githubPermissions.contents",
  "pat.githubPermissions.pullRequests",
  "pat.githubPermissions.actions",
  "pat.githubPermissions.commitStatuses",
  "pat.githubPermissions.verificationLimit",
  "pat.githubPermissions.settingsLink",
  "pat.scopeGuidance.githubClassic",
  "pat.scopeGuidance.gitlab",
  "pat.scopeGuidance.gitea",
  "pat.scopeGuidance.other",
  "pat.unsupportedProvider",
  "pat.errorTitle",
  "pat.genericError",
  "pat.submit",
  "pat.submitting",
];

// The repo-binding half of the same feature lives in the gitRepos namespace.
const GIT_REPO_KEYS = [
  "connectionLabel",
  "connectionNone",
  "connectionHint",
  "connectionNoneAvailable",
  "connectionAdminOnly",
  "connectionBadge",
  "pickFromConnectionTitle",
  "pickFromConnectionSubtitle",
  "pickConnectionPlaceholder",
];

const GIT_REPO_IDENTICAL_BY_DESIGN = ["connectionBadge"];

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

const enSection = (en as Record<string, unknown>).integrations as Record<
  string,
  unknown
>;
const esSection = (es as Record<string, unknown>).integrations as Record<
  string,
  unknown
>;
const enRepos = (en as Record<string, unknown>).gitRepos as Record<
  string,
  unknown
>;
const esRepos = (es as Record<string, unknown>).gitRepos as Record<
  string,
  unknown
>;

describe("integrations locales — es is hand-written, never a silent en fallback", () => {
  it("has an integrations namespace in both locales", () => {
    expect(enSection).toBeDefined();
    expect(esSection).toBeDefined();
  });

  it.each(SAMPLE_KEYS)("integrations.%s exists in both locales", (key) => {
    const enValue = lookup(enSection, key);
    const esValue = lookup(esSection, key);

    expect(enValue, `en missing integrations.${key}`).toBeTypeOf("string");
    expect(esValue, `es missing integrations.${key}`).toBeTypeOf("string");
    // bitbucket's guidance is intentionally empty (the provider is blocked).
    if (!key.endsWith("bitbucket")) {
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it.each(SAMPLE_KEYS.filter((k) => !IDENTICAL_BY_DESIGN.includes(k)))(
    "integrations.%s is translated, not copied from en",
    (key) => {
      expect(
        lookup(esSection, key),
        `es value for integrations.${key} mirrors en`,
      ).not.toBe(lookup(enSection, key));
    },
  );

  it.each(GIT_REPO_KEYS)("gitRepos.%s exists in both locales", (key) => {
    expect(lookup(enRepos, key), `en missing gitRepos.${key}`).toBeTypeOf(
      "string",
    );
    expect(lookup(esRepos, key), `es missing gitRepos.${key}`).toBeTypeOf(
      "string",
    );
  });

  it.each(GIT_REPO_KEYS.filter((k) => !GIT_REPO_IDENTICAL_BY_DESIGN.includes(k)))(
    "gitRepos.%s is translated, not copied from en",
    (key) => {
      expect(
        lookup(esRepos, key),
        `es value for gitRepos.${key} mirrors en`,
      ).not.toBe(lookup(enRepos, key));
    },
  );

  it("carries a provider label for every provider the backend accepts", () => {
    // The backend's GitProvider enum — a missing entry renders a raw key in
    // the provider Select.
    for (const provider of ["github", "gitlab", "gitea", "bitbucket", "other"]) {
      expect(
        lookup(enRepos, `providers.${provider}`),
        `en missing gitRepos.providers.${provider}`,
      ).toBeTypeOf("string");
      expect(
        lookup(esRepos, `providers.${provider}`),
        `es missing gitRepos.providers.${provider}`,
      ).toBeTypeOf("string");
    }
  });

  it("keeps copy free of exclamation marks in both locales", () => {
    for (const key of SAMPLE_KEYS) {
      expect(String(lookup(enSection, key))).not.toContain("!");
      expect(String(lookup(esSection, key))).not.toContain("¡");
      expect(String(lookup(esSection, key))).not.toContain("!");
    }
  });

  it("never promises the token can be read back", () => {
    // The platform cannot show a stored token again — copy that implies
    // otherwise would be a lie the UI can't honor.
    for (const locale of [enSection, esSection]) {
      const hint = String(lookup(locale, "pat.tokenHint"));
      expect(hint.toLowerCase()).not.toMatch(/reveal|mostrar de nuevo/);
    }
  });
});
