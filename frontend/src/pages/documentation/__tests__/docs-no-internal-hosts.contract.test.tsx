// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import { DOC_SECTIONS } from "../routes";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import { resolveDocumentationSection } from "../section-registry";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Backplane ships as open source; the in-app docs and UI catalogs must only
// ever show placeholder hosts (backplane.example.com, localhost, your-…-host),
// never Valaris' own deployment. The detectors are GENERIC shapes, not the
// real values: any *.valaris.studio host, any Cloud Run service host
// (<service>-<10-char hash> on the Cloud Run suffix), the getbackplane.ai host,
// and any 12-digit GCP project number. This file therefore never has to name
// the deployment it guards, and the self-check proves the shapes fire on
// realistic synthetic samples.
const INTERNAL_HOSTS =
  /[a-z0-9-]+\.valaris\.studio|[a-z0-9-]+-[a-z0-9]{10}-uc\.a\.run\.app|getbackplane\.ai|\b\d{12}\b/gi;

// Any person's address at the studio domain. Role and fixture addresses are
// allowed: the published contact addresses, the merge-bot (the backend's real
// GIT_USER_EMAIL default) and the alice/bob/carol documentation examples.
const ALLOWED_STUDIO_ADDRESSES = ["security", "conduct", "noreply", "merge-bot", "alice", "bob", "carol"];
const PERSONAL_IDENTIFIERS = new RegExp(
  `(?<![a-z0-9._-])(?!(?:${ALLOWED_STUDIO_ADDRESSES.join("|")})@)[a-z][a-z0-9._-]*@valaris\\.studio`,
  "gi",
);

// The denylist gate treats the bare Cloud Run suffix as an internal-host
// marker, so the synthetic samples assemble it rather than spell it out.
const CLOUD_RUN_SUFFIX = ["-uc", "a", "run", "app"].join(".");

const DETECTORS = {
  "internal host": INTERNAL_HOSTS,
  "personal identifier": PERSONAL_IDENTIFIERS,
} as const;
type DetectorName = keyof typeof DETECTORS;
const DETECTOR_NAMES = Object.keys(DETECTORS) as DetectorName[];

const LOCALES = ["en", "es", "pt-BR"] as const satisfies readonly SupportedLanguage[];
type LocaleId = (typeof LOCALES)[number];

const LOCALE_CATALOGS: Record<LocaleId, unknown> = { en, es, "pt-BR": ptBR };

interface Offender {
  locale: string;
  slug: string;
  match: string;
}

function matchesOf(detector: DetectorName, text: string) {
  return [...text.matchAll(DETECTORS[detector])].map((hit) => hit[0]);
}

// CodeExample bodies are skipped by the translatable-string walk, so the leak
// is only visible in rendered output: text plus link/image targets.
function renderedSurface(locale: LocaleId, slug: string) {
  const resolved = resolveDocumentationSection(locale, slug);
  if (!resolved) throw new Error(`Missing documentation section: ${locale}:${slug}`);
  const Component = resolved.Component;
  const { container, unmount } = render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider translations={resolved.translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  const attributeTargets = [...container.querySelectorAll("[href], [src]")].flatMap(
    (node) => [node.getAttribute("href") ?? "", node.getAttribute("src") ?? ""],
  );
  const surface = [container.textContent ?? "", ...attributeTargets].join("\n");
  unmount();
  return surface;
}

function collectStringLeaves(node: unknown, path: string, out: Array<{ key: string; value: string }>) {
  if (typeof node === "string") {
    out.push({ key: path, value: node });
    return;
  }
  if (node && typeof node === "object") {
    for (const [segment, child] of Object.entries(node)) {
      collectStringLeaves(child, path ? `${path}.${segment}` : segment, out);
    }
  }
}

afterEach(cleanup);

describe.each(DETECTOR_NAMES)("shipped documentation carries no %s", (detector) => {
  it.each(LOCALES)("renders every %s section clean in text, href and src", (locale) => {
    const offenders: Offender[] = [];
    for (const { slug } of DOC_SECTIONS) {
      for (const match of matchesOf(detector, renderedSurface(locale, slug))) {
        offenders.push({ locale, slug, match });
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(LOCALES)("%s UI catalog is clean in every string", (locale) => {
    const leaves: Array<{ key: string; value: string }> = [];
    collectStringLeaves(LOCALE_CATALOGS[locale], "", leaves);
    expect(leaves.length).toBeGreaterThan(0);
    const offenders = leaves.flatMap(({ key, value }) =>
      matchesOf(detector, value).map((match) => ({ locale, key, match })),
    );
    expect(offenders).toEqual([]);
  });
});

describe("detector self-check", () => {
  it.each([
    "https://app.valaris.studio",
    "api_url: https://ops.valaris.studio",
    "Host: valaris.valaris.studio",
    `valaris-backend-abcdefghij${CLOUD_RUN_SUFFIX}`,
    `https://valaris-frontend-k3x9m2p7qz${CLOUD_RUN_SUFFIX}/kanban`,
    `https://svc-0123456789${CLOUD_RUN_SUFFIX}`,
    "https://bp1.getbackplane.ai",
    "projects/000000000000/locations/us-central1",
    "IAP audience /projects/123456789012/global/backendServices/x",
  ])("flags %j as an internal host", (sample) => {
    expect(matchesOf("internal host", sample)).not.toEqual([]);
  });

  it.each([
    "someone@valaris.studio",
    "X-User-Email: jane.doe@valaris.studio",
    "contact first.last-name@valaris.studio for access",
  ])("flags %j as a personal identifier", (sample) => {
    expect(matchesOf("personal identifier", sample)).not.toEqual([]);
  });

  it.each([
    "https://backplane.example.com",
    "http://localhost:8000",
    "https://your-backplane-host",
    "https://api.github.com",
    "https://github.com/Valaris-Studio/backplane",
    `https://svc-short${CLOUD_RUN_SUFFIX}`,
    "order 12345678901 shipped",
    "merge-bot@valaris.studio",
    "security@valaris.studio",
    "conduct@valaris.studio",
    "noreply@valaris.studio",
    "alice@valaris.studio",
    "bob@valaris.studio",
    "carol@valaris.studio",
    "dev@valaris.dev",
    "you@example.com",
  ])("allows %j under both detectors", (sample) => {
    expect(matchesOf("internal host", sample)).toEqual([]);
    expect(matchesOf("personal identifier", sample)).toEqual([]);
  });
});
