// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupportedLanguage } from "@/i18n/supported-languages";
import type { DocGroupId, DocSectionSlug } from "../routes";

export type DocumentationLocale = SupportedLanguage;

export interface DocumentationShellCopy {
  eyebrow: string;
  title: string;
  description: string;
  tableOfContents: string;
  tableOfContentsAriaLabel: string;
  sectionsAriaLabel: string;
  breadcrumbAriaLabel: string;
  breadcrumbRoot: string;
  startHere: string;
  notFoundBreadcrumb: string;
  notFoundTitle: string;
  notFoundBody: string;
  fallbackTitle: string;
  fallbackBody: string;
  copyCode: string;
  copiedCode: string;
  copiedToast: string;
  screenshotPlaceholder: string;
}

export interface DocumentationLandingCopy {
  eyebrow: string;
  title: string;
  description: string;
  featuredLabel: string;
  featuredDescription: string;
}

export interface DocumentationMcpReferenceCopy {
  navAriaLabel: string;
  searchAriaLabel: string;
  searchPlaceholder: string;
  filterAriaLabel: string;
  filterLabels: Record<"all" | "read" | "write" | "composite", string>;
  noMatches: string;
  noMatchesFor: string;
  clearSearchAndFilters: string;
  promptsGroup: string;
  resourcesGroup: string;
  noResultsDetail: string;
  selectDetailBeforeShortcut: string;
  selectDetailAfterShortcut: string;
  copyToolId: string;
  parameters: string;
  gotchas: string;
  dangerZone: string;
  examplePrompt: string;
  relatedTools: string;
  backToList: string;
  noParameters: string;
  parameterName: string;
  parameterRequired: string;
  parameterDescription: string;
  requiredValue: string;
  optionalValue: string;
  copyExamplePrompt: string;
  annotationReadOnly: string;
  annotationDestructive: string;
  annotationIdempotent: string;
  wireDescriptionTitle: string;
  inDefaultHand: string;
}

export interface DocumentationLocaleCopy {
  locale: DocumentationLocale;
  version: string;
  shell: DocumentationShellCopy;
  landing: DocumentationLandingCopy;
  mcpReference: DocumentationMcpReferenceCopy;
  groupTitles: Record<DocGroupId, string>;
  sectionTitles: Record<DocSectionSlug, string>;
}
