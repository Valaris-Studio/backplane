// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getDocumentationCopy } from "./content";

export const DOC_GROUPS = [
  { id: "introduction", title: "Introduction" },
  { id: "core-concepts", title: "Core Concepts" },
  { id: "installing", title: "Installing Backplane" },
  { id: "getting-started", title: "Getting Started" },
  { id: "configuration", title: "Configuration" },
  { id: "operating", title: "Operating the Platform" },
  { id: "under-the-hood", title: "Under the Hood" },
  { id: "extending", title: "Extending Backplane" },
  { id: "reference", title: "Reference" },
  { id: "honest-remarks", title: "Honest Remarks" },
] as const;

export type DocGroupId = (typeof DOC_GROUPS)[number]["id"];

export interface DocGroup {
  id: DocGroupId;
  title: string;
}

export interface DocSection {
  slug: string;
  title: string;
  group: DocGroupId;
  order: number;
}

export const DOC_SECTIONS = [
  // Introduction
  { slug: "what-backplane-is", title: "What Backplane Is", group: "introduction", order: 10 },
  { slug: "what-it-is-not", title: "What It Is NOT", group: "introduction", order: 20 },
  { slug: "quick-tour", title: "Quick Tour (5-minute read)", group: "introduction", order: 30 },

  // Core Concepts
  { slug: "workspaces-boards-columns-cards", title: "Workspaces, Boards, Columns, Cards", group: "core-concepts", order: 10 },
  { slug: "runners", title: "Runners (the credentialed process)", group: "core-concepts", order: 20 },
  { slug: "agent-teams", title: "Agent Teams", group: "core-concepts", order: 30 },
  { slug: "roles-and-pipelines", title: "Roles and Pipelines", group: "core-concepts", order: 40 },
  { slug: "prompts", title: "Prompts", group: "core-concepts", order: 50 },
  { slug: "approvals", title: "Approvals", group: "core-concepts", order: 60 },
  { slug: "loop-mode", title: "Loop Mode", group: "core-concepts", order: 70 },
  { slug: "skills", title: "Skills (versioned procedural knowledge)", group: "core-concepts", order: 80 },

  // Installing Backplane
  { slug: "install-with-docker-compose", title: "Install with Docker Compose", group: "installing", order: 10 },
  { slug: "securing-a-self-hosted-deployment", title: "Securing a Self-Hosted Deployment", group: "installing", order: 20 },
  { slug: "upgrading-backplane", title: "Upgrading Backplane", group: "installing", order: 30 },
  { slug: "backup-and-restore", title: "Backup and Restore", group: "installing", order: 40 },

  // Getting Started
  { slug: "creating-your-first-workspace", title: "Creating Your First Workspace", group: "getting-started", order: 10 },
  { slug: "your-first-board-and-card", title: "Your First Board and Card", group: "getting-started", order: 20 },
  { slug: "installing-the-mcp-server", title: "Installing the MCP Server in Your Agent Client", group: "getting-started", order: 30 },
  { slug: "registering-a-runner", title: "Registering a Runner", group: "getting-started", order: 40 },
  { slug: "your-first-pipeline-run", title: "Your First Pipeline Run (Guided Walkthrough)", group: "getting-started", order: 50 },
  { slug: "troubleshooting-your-first-run", title: "Troubleshooting Your First Run", group: "getting-started", order: 60 },

  // Configuration
  { slug: "pipeline-builder", title: "Pipeline Builder — Every Field Explained", group: "configuration", order: 10 },
  { slug: "prompt-authoring-guide", title: "Prompt Authoring Guide", group: "configuration", order: 20 },
  { slug: "custom-roles", title: "Custom Roles (the real payoff)", group: "configuration", order: 30 },
  { slug: "sensors", title: "Sensors", group: "configuration", order: 40 },
  { slug: "approval-categories-and-risk-scoring", title: "Approval Categories and Risk Scoring", group: "configuration", order: 50 },
  { slug: "budget-and-cost-controls", title: "Budget and Cost Controls", group: "configuration", order: 60 },
  { slug: "git-configuration-and-review-modes", title: "Git Configuration and Review Modes", group: "configuration", order: 70 },

  // Operating the Platform
  { slug: "reading-the-runner-overview", title: "Reading the Runner Overview", group: "operating", order: 10 },
  { slug: "debugging-a-stuck-card", title: "Debugging a Stuck Card", group: "operating", order: 20 },
  { slug: "the-observer-panel", title: "The Observer Panel", group: "operating", order: 30 },
  { slug: "activity-history-and-audit-logs", title: "Activity History and Audit Logs", group: "operating", order: 40 },
  { slug: "webhooks-and-external-notifications", title: "Webhooks and External Notifications", group: "operating", order: 50 },
  { slug: "rollback-and-recovery-playbook", title: "Rollback and Recovery Playbook", group: "operating", order: 60 },

  // Under the Hood
  { slug: "architecture-overview", title: "Architecture Overview (the four surfaces)", group: "under-the-hood", order: 10 },
  { slug: "event-bus-and-websocket-model", title: "The Event Bus and WebSocket Model", group: "under-the-hood", order: 20 },
  { slug: "fractional-indexing", title: "Fractional Indexing", group: "under-the-hood", order: 30 },
  { slug: "idempotency", title: "Idempotency and Why It Matters", group: "under-the-hood", order: 40 },
  { slug: "platform-authority-principle", title: "Platform Authority Principle", group: "under-the-hood", order: 50 },
  { slug: "model-agnostic-roles", title: "Model-Agnostic Roles (future-facing)", group: "under-the-hood", order: 60 },

  // Extending Backplane
  { slug: "adding-a-new-mcp-tool", title: "Adding a New MCP Tool", group: "extending", order: 10 },
  { slug: "adding-a-new-pipeline-stage-variant", title: "Adding a New Pipeline Stage Variant", group: "extending", order: 20 },
  { slug: "integrating-a-new-git-host", title: "Integrating a New Git Host", group: "extending", order: 30 },
  { slug: "writing-a-custom-sensor", title: "Writing a Custom Sensor", group: "extending", order: 40 },

  // Reference
  // Counts intentionally absent from titles — the explorer derives them from data.
  { slug: "mcp-tool-catalog", title: "MCP Tool Catalog", group: "reference", order: 10 },
  { slug: "mcp-toolsets", title: "MCP Toolsets", group: "reference", order: 15 },
  { slug: "mcp-prompt-catalog", title: "MCP Prompt Catalog", group: "reference", order: 20 },
  { slug: "event-taxonomy", title: "Event Taxonomy", group: "reference", order: 30 },
  { slug: "column-type-semantics", title: "Column Type Semantics", group: "reference", order: 40 },
  { slug: "card-type-and-priority", title: "Card Type and Priority", group: "reference", order: 50 },
  { slug: "api-authentication-modes", title: "API Authentication Modes", group: "reference", order: 60 },
  { slug: "environment-variables", title: "Environment Variables", group: "reference", order: 70 },

  // Honest Remarks
  { slug: "what-works-well", title: "What Works Well", group: "honest-remarks", order: 10 },
  { slug: "known-rough-edges", title: "Known Rough Edges", group: "honest-remarks", order: 20 },
  { slug: "actively-working-on", title: "What We're Actively Working On", group: "honest-remarks", order: 30 },
  { slug: "the-north-star", title: "The North Star", group: "honest-remarks", order: 40 },
] as const satisfies readonly DocSection[];

export type DocSectionSlug = (typeof DOC_SECTIONS)[number]["slug"];

function requireLocalizedTitle(
  title: string | undefined,
  kind: "group" | "section",
  key: string,
  language: string,
): string {
  if (!title?.trim()) {
    throw new Error(
      `Missing documentation ${kind} title "${key}" for locale "${language}"`,
    );
  }
  return title;
}

export function getDocGroups(language: string): DocGroup[] {
  const { groupTitles } = getDocumentationCopy(language);
  return DOC_GROUPS.map(({ id }) => ({
    id,
    title: requireLocalizedTitle(groupTitles[id], "group", id, language),
  }));
}

export function getDocSections(language: string): DocSection[] {
  const { sectionTitles } = getDocumentationCopy(language);
  return DOC_SECTIONS.map((section) => ({
    ...section,
    title: requireLocalizedTitle(
      sectionTitles[section.slug],
      "section",
      section.slug,
      language,
    ),
  }));
}

export function findSection(
  slug: string,
  language = "en",
): DocSection | undefined {
  return getDocSections(language).find((section) => section.slug === slug);
}

export function sectionsByGroup(
  groupId: DocGroupId,
  language = "en",
): DocSection[] {
  return getDocSections(language).filter((section) => section.group === groupId).sort(
    (a, b) => a.order - b.order,
  );
}

export const LANDING_FEATURED_SLUG = "what-backplane-is";
