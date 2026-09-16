// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOC_SECTIONS } from "../routes";
import { resolveDocumentationSection } from "../section-registry";
import { DocumentationSectionTranslationProvider } from "../section-localization";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

interface RenderedSectionContract {
  anchors: Set<string>;
  hrefs: string[];
}

const DOCUMENTATION_ORIGIN = "https://documentation.test";
const WORKSPACE_SLUG = "contract-workspace";
const KNOWN_SECTION_SLUGS: ReadonlySet<string> = new Set(
  DOC_SECTIONS.map(({ slug }) => slug),
);

afterEach(cleanup);

function renderSectionContract(slug: string): RenderedSectionContract {
  const resolved = resolveDocumentationSection("en", slug);
  if (!resolved) throw new Error(`Missing documentation section: ${slug}`);
  const Component = resolved.Component;
  const { container, unmount } = render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider translations={{}}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  const contract = {
    anchors: new Set(
      Array.from(container.querySelectorAll<HTMLElement>("[id]")).map(
        ({ id }) => id,
      ),
    ),
    hrefs: Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]")).map(
      (link) => link.getAttribute("href") ?? "",
    ),
  };
  unmount();
  return contract;
}

function documentationTarget(
  href: string,
  sourceSlug: string,
  workspaceScoped: boolean,
): { slug: string; hash: string } | undefined {
  const basePath = workspaceScoped
    ? `/${WORKSPACE_SLUG}/documentation/${sourceSlug}`
    : `/documentation/${sourceSlug}`;
  const target = new URL(href, `${DOCUMENTATION_ORIGIN}${basePath}`);
  if (target.origin !== DOCUMENTATION_ORIGIN) return undefined;

  const prefix = workspaceScoped
    ? `/${WORKSPACE_SLUG}/documentation/`
    : "/documentation/";
  if (!target.pathname.startsWith(prefix)) {
    throw new Error(`${sourceSlug}: ${href} resolves outside ${prefix}`);
  }

  return {
    slug: target.pathname.slice(prefix.length).replace(/\/$/, ""),
    hash: target.hash.slice(1),
  };
}

describe("documentation authored-link contract", () => {
  it.each([false, true])(
    "resolves every internal href and hash in %s workspace scope",
    (workspaceScoped) => {
      const contracts = new Map<string, RenderedSectionContract>(
        DOC_SECTIONS.map(({ slug }) => [slug, renderSectionContract(slug)]),
      );

      for (const [sourceSlug, contract] of contracts) {
        for (const href of contract.hrefs) {
          const target = documentationTarget(href, sourceSlug, workspaceScoped);
          if (!target) continue;

          expect(KNOWN_SECTION_SLUGS.has(target.slug), `${sourceSlug}: ${href}`).toBe(
            true,
          );
          if (target.hash !== "") {
            expect(
              contracts.get(target.slug)?.anchors.has(target.hash),
              `${sourceSlug}: ${href} points to a missing anchor`,
            ).toBe(true);
          }
        }
      }
    },
  );
});
