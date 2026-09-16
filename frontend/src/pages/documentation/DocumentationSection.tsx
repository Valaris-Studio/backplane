// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import { DocumentationSectionTitleProvider } from "./section-title-context";
import { resolveDocumentationSection } from "./section-registry";
import { BreadcrumbBar } from "./shell/BreadcrumbBar";
import { SectionPage } from "./shell/SectionPage";
import { findSection, getDocGroups } from "./routes";
import { DocumentationSectionTranslationProvider } from "./section-localization";
import { useDocumentationCopy } from "./use-documentation-copy";
import { useDocsBasePath } from "./use-docs-base-path";

export function DocumentationSection() {
  const { sectionSlug = "" } = useParams();
  const { hash } = useLocation();
  const { copy, locale } = useDocumentationCopy();
  const section = findSection(sectionSlug, locale);
  const resolvedSection = resolveDocumentationSection(locale, sectionSlug);
  const groupTitle = section
    ? getDocGroups(locale).find(({ id }) => id === section.group)?.title
    : undefined;
  const basePath = useDocsBasePath();

  useEffect(() => {
    if (!hash) return;
    // Explorer selection hashes are state, not anchors. Resource URIs can
    // contain '%' and getElementById remains safe for every possible hash.
    if (/^#(tool|prompt|resource)-/.test(hash)) return;
    const target = document.getElementById(hash.slice(1));
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hash, sectionSlug]);

  if (!section || !resolvedSection) {
    return (
      <div className="space-y-6">
        <BreadcrumbBar
          rootHref={basePath}
          currentTitle={copy.shell.notFoundBreadcrumb}
        />
        <SectionPage title={copy.shell.notFoundTitle}>
          <p>{copy.shell.notFoundBody}</p>
        </SectionPage>
      </div>
    );
  }

  const { Component, status, translations } = resolvedSection;

  return (
    <DocumentationSectionTitleProvider
      title={section.title}
      eyebrow={groupTitle}
    >
      <DocumentationSectionTranslationProvider translations={translations}>
        <div className="space-y-6">
          <BreadcrumbBar rootHref={basePath} currentTitle={section.title} />
          {status === "fallback" || status === "missing" ? (
            <aside
              role="note"
              className="rounded-[var(--radius-md)] border border-primary/35 bg-primary/5 px-4 py-3 text-sm text-foreground/85"
            >
              <p className="font-semibold text-foreground">
                {copy.shell.fallbackTitle}
              </p>
              <p className="mt-1 text-muted-foreground">
                {copy.shell.fallbackBody}
              </p>
            </aside>
          ) : null}
          <Component />
        </div>
      </DocumentationSectionTranslationProvider>
    </DocumentationSectionTitleProvider>
  );
}
