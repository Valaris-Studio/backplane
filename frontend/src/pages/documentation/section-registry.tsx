// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactElement, ReactNode } from "react";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import { ES_SECTION_TRANSLATIONS } from "./content/sections/es";
import { PT_BR_SECTION_TRANSLATIONS } from "./content/sections/pt-BR";
import { collectMcpReferenceTranslatableStrings } from "./mcp-reference/localization-contract";
import { DOC_SECTIONS } from "./routes";
import {
  collectDocumentationTranslatableStrings,
  type DocumentationSectionTranslations,
} from "./section-localization";
import { IntroductionWhatBackplaneIs } from "./sections/introduction-what-backplane-is";
import { IntroductionWhatItIsNot } from "./sections/introduction-what-it-is-not";
import { IntroductionQuickTour } from "./sections/introduction-quick-tour";
import { CoreConceptsWorkspacesBoardsColumnsCards } from "./sections/core-concepts-workspaces-boards-columns-cards";
import { CoreConceptsRunners } from "./sections/core-concepts-runners";
import { CoreConceptsAgentTeams } from "./sections/core-concepts-agent-teams";
import { CoreConceptsRolesAndPipelines } from "./sections/core-concepts-roles-and-pipelines";
import { CoreConceptsPrompts } from "./sections/core-concepts-prompts";
import { CoreConceptsApprovals } from "./sections/core-concepts-approvals";
import { CoreConceptsLoopMode } from "./sections/core-concepts-loop-mode";
import { CoreConceptsSkills } from "./sections/core-concepts-skills";
import { InstallingInstallWithDockerCompose } from "./sections/installing-install-with-docker-compose";
import { InstallingSecuringASelfHostedDeployment } from "./sections/installing-securing-a-self-hosted-deployment";
import { InstallingUpgradingBackplane } from "./sections/installing-upgrading-backplane";
import { InstallingBackupAndRestore } from "./sections/installing-backup-and-restore";
import { GettingStartedCreatingYourFirstWorkspace } from "./sections/getting-started-creating-your-first-workspace";
import { GettingStartedYourFirstBoardAndCard } from "./sections/getting-started-your-first-board-and-card";
import { GettingStartedInstallingTheMcpServer } from "./sections/getting-started-installing-the-mcp-server";
import { GettingStartedRegisteringARunner } from "./sections/getting-started-registering-a-runner";
import { GettingStartedYourFirstPipelineRun } from "./sections/getting-started-your-first-pipeline-run";
import { GettingStartedTroubleshootingYourFirstRun } from "./sections/getting-started-troubleshooting-your-first-run";
import { ConfigurationPipelineBuilder } from "./sections/configuration-pipeline-builder";
import { ConfigurationPromptAuthoringGuide } from "./sections/configuration-prompt-authoring-guide";
import { ConfigurationCustomRoles } from "./sections/configuration-custom-roles";
import { ConfigurationSensors } from "./sections/configuration-sensors";
import { ConfigurationApprovalCategoriesAndRiskScoring } from "./sections/configuration-approval-categories-and-risk-scoring";
import { ConfigurationBudgetAndCostControls } from "./sections/configuration-budget-and-cost-controls";
import { ConfigurationGitConfigurationAndReviewModes } from "./sections/configuration-git-configuration-and-review-modes";
import { OperatingReadingTheRunnerOverview } from "./sections/operating-reading-the-runner-overview";
import { OperatingDebuggingAStuckCard } from "./sections/operating-debugging-a-stuck-card";
import { OperatingTheObserverPanel } from "./sections/operating-the-observer-panel";
import { OperatingActivityHistoryAndAuditLogs } from "./sections/operating-activity-history-and-audit-logs";
import { OperatingWebhooksAndExternalNotifications } from "./sections/operating-webhooks-and-external-notifications";
import { OperatingRollbackAndRecoveryPlaybook } from "./sections/operating-rollback-and-recovery-playbook";
import { UnderTheHoodArchitectureOverview } from "./sections/under-the-hood-architecture-overview";
import { UnderTheHoodEventBusAndWebsocketModel } from "./sections/under-the-hood-event-bus-and-websocket-model";
import { UnderTheHoodFractionalIndexing } from "./sections/under-the-hood-fractional-indexing";
import { UnderTheHoodIdempotency } from "./sections/under-the-hood-idempotency";
import { UnderTheHoodPlatformAuthorityPrinciple } from "./sections/under-the-hood-platform-authority-principle";
import { UnderTheHoodModelAgnosticRoles } from "./sections/under-the-hood-model-agnostic-roles";
import { ExtendingAddingANewMcpTool } from "./sections/extending-adding-a-new-mcp-tool";
import { ExtendingAddingANewPipelineStageVariant } from "./sections/extending-adding-a-new-pipeline-stage-variant";
import { ExtendingIntegratingANewGitHost } from "./sections/extending-integrating-a-new-git-host";
import { ExtendingWritingACustomSensor } from "./sections/extending-writing-a-custom-sensor";
import { ReferenceMcpToolCatalog } from "./sections/reference-mcp-tool-catalog";
import {
  MCP_PROMPT_CATALOG_EMPTY_SUMMARY,
  ReferenceMcpPromptCatalog,
} from "./sections/reference-mcp-prompt-catalog";
import { MCP_TOOL_CATALOG_EMPTY_SUMMARY } from "./sections/reference-mcp-tool-catalog";
import {
  MCP_TOOLSETS_DEPRECATED_ALIASES_STRINGS,
  ReferenceMcpToolsets,
} from "./sections/reference-mcp-toolsets";
import { ReferenceEventTaxonomy } from "./sections/reference-event-taxonomy";
import { ReferenceColumnTypeSemantics } from "./sections/reference-column-type-semantics";
import { ReferenceCardTypeAndPriority } from "./sections/reference-card-type-and-priority";
import { ReferenceApiAuthenticationModes } from "./sections/reference-api-authentication-modes";
import { ReferenceEnvironmentVariables } from "./sections/reference-environment-variables";
import { HonestRemarksWhatWorksWell } from "./sections/honest-remarks-what-works-well";
import { HonestRemarksKnownRoughEdges } from "./sections/honest-remarks-known-rough-edges";
import { HonestRemarksActivelyWorkingOn } from "./sections/honest-remarks-actively-working-on";
import { HonestRemarksTheNorthStar } from "./sections/honest-remarks-the-north-star";

export type DocumentationSectionRenderer = () => ReactElement;
export type DocumentationTranslationStatus =
  | "source"
  | "translated"
  | "fallback"
  | "missing";

export interface ResolvedDocumentationSection {
  Component: DocumentationSectionRenderer;
  translations: DocumentationSectionTranslations;
  locale: SupportedLanguage;
  sourceLocale: "en";
  status: DocumentationTranslationStatus;
}

export const SOURCE_SECTION_RENDERERS: Record<
  string,
  DocumentationSectionRenderer
> = {
  "what-backplane-is": IntroductionWhatBackplaneIs,
  "what-it-is-not": IntroductionWhatItIsNot,
  "quick-tour": IntroductionQuickTour,
  "workspaces-boards-columns-cards": CoreConceptsWorkspacesBoardsColumnsCards,
  runners: CoreConceptsRunners,
  "agent-teams": CoreConceptsAgentTeams,
  "roles-and-pipelines": CoreConceptsRolesAndPipelines,
  prompts: CoreConceptsPrompts,
  approvals: CoreConceptsApprovals,
  "loop-mode": CoreConceptsLoopMode,
  skills: CoreConceptsSkills,
  "install-with-docker-compose": InstallingInstallWithDockerCompose,
  "securing-a-self-hosted-deployment": InstallingSecuringASelfHostedDeployment,
  "upgrading-backplane": InstallingUpgradingBackplane,
  "backup-and-restore": InstallingBackupAndRestore,
  "creating-your-first-workspace": GettingStartedCreatingYourFirstWorkspace,
  "your-first-board-and-card": GettingStartedYourFirstBoardAndCard,
  "installing-the-mcp-server": GettingStartedInstallingTheMcpServer,
  "registering-a-runner": GettingStartedRegisteringARunner,
  "your-first-pipeline-run": GettingStartedYourFirstPipelineRun,
  "troubleshooting-your-first-run": GettingStartedTroubleshootingYourFirstRun,
  "pipeline-builder": ConfigurationPipelineBuilder,
  "prompt-authoring-guide": ConfigurationPromptAuthoringGuide,
  "custom-roles": ConfigurationCustomRoles,
  sensors: ConfigurationSensors,
  "approval-categories-and-risk-scoring": ConfigurationApprovalCategoriesAndRiskScoring,
  "budget-and-cost-controls": ConfigurationBudgetAndCostControls,
  "git-configuration-and-review-modes": ConfigurationGitConfigurationAndReviewModes,
  "reading-the-runner-overview": OperatingReadingTheRunnerOverview,
  "debugging-a-stuck-card": OperatingDebuggingAStuckCard,
  "the-observer-panel": OperatingTheObserverPanel,
  "activity-history-and-audit-logs": OperatingActivityHistoryAndAuditLogs,
  "webhooks-and-external-notifications": OperatingWebhooksAndExternalNotifications,
  "rollback-and-recovery-playbook": OperatingRollbackAndRecoveryPlaybook,
  "architecture-overview": UnderTheHoodArchitectureOverview,
  "event-bus-and-websocket-model": UnderTheHoodEventBusAndWebsocketModel,
  "fractional-indexing": UnderTheHoodFractionalIndexing,
  idempotency: UnderTheHoodIdempotency,
  "platform-authority-principle": UnderTheHoodPlatformAuthorityPrinciple,
  "model-agnostic-roles": UnderTheHoodModelAgnosticRoles,
  "adding-a-new-mcp-tool": ExtendingAddingANewMcpTool,
  "adding-a-new-pipeline-stage-variant": ExtendingAddingANewPipelineStageVariant,
  "integrating-a-new-git-host": ExtendingIntegratingANewGitHost,
  "writing-a-custom-sensor": ExtendingWritingACustomSensor,
  "mcp-tool-catalog": ReferenceMcpToolCatalog,
  "mcp-toolsets": ReferenceMcpToolsets,
  "mcp-prompt-catalog": ReferenceMcpPromptCatalog,
  "event-taxonomy": ReferenceEventTaxonomy,
  "column-type-semantics": ReferenceColumnTypeSemantics,
  "card-type-and-priority": ReferenceCardTypeAndPriority,
  "api-authentication-modes": ReferenceApiAuthenticationModes,
  "environment-variables": ReferenceEnvironmentVariables,
  "what-works-well": HonestRemarksWhatWorksWell,
  "known-rough-edges": HonestRemarksKnownRoughEdges,
  "actively-working-on": HonestRemarksActivelyWorkingOn,
  "the-north-star": HonestRemarksTheNorthStar,
};

export const LOCALIZED_SECTION_TRANSLATIONS: Record<
  Exclude<SupportedLanguage, "en">,
  Readonly<Record<string, DocumentationSectionTranslations>>
> = {
  es: ES_SECTION_TRANSLATIONS,
  "pt-BR": PT_BR_SECTION_TRANSLATIONS,
};

const CONDITIONAL_SECTION_STRINGS: Readonly<
  Partial<Record<string, readonly string[]>>
> = {
  "mcp-tool-catalog": [MCP_TOOL_CATALOG_EMPTY_SUMMARY],
  "mcp-prompt-catalog": [MCP_PROMPT_CATALOG_EMPTY_SUMMARY],
  "mcp-toolsets": MCP_TOOLSETS_DEPRECATED_ALIASES_STRINGS,
};

export interface DocumentationTranslationKeyParity {
  missing: string[];
  unexpected: string[];
}

export function resolveDocumentationSection(
  locale: SupportedLanguage,
  slug: string,
): ResolvedDocumentationSection | undefined {
  const source = SOURCE_SECTION_RENDERERS[slug];
  if (!source) return undefined;

  if (locale === "en") {
    return {
      Component: source,
      translations: {},
      locale,
      sourceLocale: "en",
      status: "source",
    };
  }

  const translations = LOCALIZED_SECTION_TRANSLATIONS[locale][slug];
  const status =
    translations === undefined
      ? "missing"
      : getMissingDocumentationStrings(locale, slug).length
        ? "fallback"
        : "translated";

  return {
    Component: source,
    translations:
      status === "translated" && translations !== undefined ? translations : {},
    locale,
    sourceLocale: "en",
    status,
  };
}

export function getMissingDocumentationStrings(
  locale: Exclude<SupportedLanguage, "en">,
  slug: string,
): string[] {
  const source = SOURCE_SECTION_RENDERERS[slug];
  if (!source) return [`Missing English source renderer for ${slug}`];

  const translations = LOCALIZED_SECTION_TRANSLATIONS[locale][slug] ?? {};
  return compareDocumentationTranslationKeys(
    getDocumentationSourceStrings(slug),
    translations,
  ).missing;
}

export function getUnexpectedDocumentationStrings(
  locale: Exclude<SupportedLanguage, "en">,
  slug: string,
): string[] {
  const source = SOURCE_SECTION_RENDERERS[slug];
  if (!source) return [];

  const translations = LOCALIZED_SECTION_TRANSLATIONS[locale][slug] ?? {};
  return compareDocumentationTranslationKeys(
    getDocumentationSourceStrings(slug),
    translations,
  ).unexpected;
}

export function getDocumentationSourceStrings(slug: string): string[] {
  const source = SOURCE_SECTION_RENDERERS[slug];
  if (!source) return [];

  return [
    ...new Set([
      ...collectDocumentationTranslatableStrings(sectionChildren(source())),
      ...(slug === "mcp-tool-catalog"
        ? collectMcpReferenceTranslatableStrings()
        : []),
      ...(CONDITIONAL_SECTION_STRINGS[slug] ?? []),
    ]),
  ];
}

export function compareDocumentationTranslationKeys(
  sourceStrings: readonly string[],
  translations: DocumentationSectionTranslations,
): DocumentationTranslationKeyParity {
  // Exact source text is the identity. Repeated narrative intentionally shares
  // one translation; context-specific wording must graduate to a semantic key.
  const sources = new Set(sourceStrings);
  return {
    missing: [...sources].filter(
      (value) =>
        !Object.hasOwn(translations, value) || translations[value]?.trim() === "",
    ),
    unexpected: Object.keys(translations).filter((value) => !sources.has(value)),
  };
}

export function getDocumentationCoverage(locale: SupportedLanguage) {
  const coverage = {
    source: 0,
    translated: 0,
    fallback: 0,
    total: DOC_SECTIONS.length,
  };

  for (const { slug } of DOC_SECTIONS) {
    const status = resolveDocumentationSection(locale, slug)?.status ?? "missing";
    if (status === "source") coverage.source += 1;
    if (status === "translated") coverage.translated += 1;
    if (status === "fallback" || status === "missing") coverage.fallback += 1;
  }

  return coverage;
}

function sectionChildren(element: ReactElement): ReactNode {
  return (element.props as { children?: ReactNode }).children;
}
