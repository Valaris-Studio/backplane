// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
} from "../section-registry";

const testDir = dirname(fileURLToPath(import.meta.url));
const section = (name: string) =>
  readFileSync(join(testDir, "../sections", name), "utf8");

const AUDITED_SLUGS = [
  "workspaces-boards-columns-cards",
  "runners",
  "agent-teams",
  "approvals",
  "loop-mode",
  "skills",
  "reading-the-runner-overview",
  "debugging-a-stuck-card",
  "the-observer-panel",
  "activity-history-and-audit-logs",
  "webhooks-and-external-notifications",
] as const;

describe("core and operating documentation parity with main", () => {
  it.each(["es", "pt-BR"] as const)(
    "keeps every audited %s section explicitly localized",
    (locale) => {
      for (const slug of AUDITED_SLUGS) {
        expect(
          getMissingDocumentationStrings(locale, slug),
          `${locale}:${slug} has missing narrative`,
        ).toEqual([]);
        expect(
          getUnexpectedDocumentationStrings(locale, slug),
          `${locale}:${slug} has stale narrative`,
        ).toEqual([]);
      }
    },
  );

  it("documents every executable runner mode and the validated host config", () => {
    const source = section("core-concepts-runners.tsx");

    for (const token of [
      "-doctor",
      "-discover",
      "-loop",
      "-loop-board",
      "-keep-alive",
      "VALARIS_API_KEY",
      "VALARIS_WORKSPACE",
      "mcp_config_path",
      "git.base_dir",
      "claude-cli",
      "codex-cli",
    ]) {
      expect(source, token).toContain(token);
    }

    expect(source).not.toContain("distributed as source today");
  });

  it("distinguishes a disabled keep-alive loop from a parked enabled loop", () => {
    const source = section("core-concepts-loop-mode.tsx");

    expect(source).toContain("loop_mode.keep_alive");
    expect(source).toContain("-keep-alive");
    expect(source).toContain("idle_waiting");
    expect(source).toContain("parked");
    expect(source).toContain("board.loop_updated");
    expect(source).toMatch(/safety rails[\s\S]*still exit/i);
  });

  it("documents loop-mode skill refresh and the proposal switch", () => {
    const source = section("core-concepts-loop-mode.tsx");

    expect(source).toContain("skills_proposal_enabled");
    expect(source).toContain("propose_skill");
    expect(source).toMatch(/skills[\s\S]*every iteration/i);
  });

  it("documents the skills lifecycle, materialization and proposal gate", () => {
    const source = section("core-concepts-skills.tsx");

    for (const token of [
      "SKILL.md",
      ".claude/skills",
      ".codex/skills",
      "skills_setup",
      "propose_skill",
      "skills_proposal_enabled",
      "list_skills",
      "get_skill",
      ".git/info/exclude",
      "bash scripts/",
    ]) {
      expect(source, token).toContain(token);
    }

    expect(source).toMatch(/never auto-approve/i);
    expect(source).toMatch(/32[\s\S]*64[\s\S]*512/);
    expect(source).not.toMatch(/agents publish/i);
  });

  it("describes the current approval threshold, park and rejection contracts", () => {
    const source = section("core-concepts-approvals.tsx");

    expect(source).toMatch(/less than or equal to[\s\S]*30/i);
    expect(source).toContain("AUTO_APPROVE_THRESHOLD");
    expect(source).toContain("expires_at");
    expect(source).toContain("awaiting-approval");
    expect(source).toMatch(/park[\s\S]*continues with other cards/i);
    expect(source).toMatch(/WebSocket[\s\S]*HTTP/i);
    expect(source).toMatch(/rejection[\s\S]*terminal/i);
    expect(source).not.toContain("no HTTP polling");
    expect(source).toContain("skill_publication");
  });

  it("keeps the overview limited to the panels that actually render there", () => {
    const source = section("operating-reading-the-runner-overview.tsx");

    for (const panel of [
      "five",
      "Total runners",
      "Success rate",
      "Average duration",
      "Total tokens",
      "Total cost",
      "Pending approvals",
      "Analytics dashboard",
    ]) {
      expect(source, panel).toMatch(new RegExp(panel, "i"));
    }

    expect(source).not.toContain("AgentTable.");
    expect(source).not.toContain("ExecutionTimeline.");
    expect(source).not.toContain("TeamPanel");
  });

  it("documents server-side activity filtering, bounded pages and board replay", () => {
    const source = section("operating-activity-history-and-audit-logs.tsx");

    expect(source).toMatch(/server-side/i);
    expect(source).toMatch(/50[\s\S]*three/i);
    expect(source).toMatch(/entity type[\s\S]*action[\s\S]*search/i);
    expect(source).toContain("/{slug}/boards/{id}/timeline");
    expect(source).toContain("5000");
    expect(source).not.toContain("filters client-side");
    expect(source).not.toContain("actor filter");
    expect(source).not.toContain("default 24-hour window");
  });

  it("documents the observer's real default chip semantics and expandable payloads", () => {
    const source = section("operating-the-observer-panel.tsx");

    expect(source).toMatch(/no chip[\s\S]*four agentic namespaces/i);
    expect(source).toMatch(/All[\s\S]*clears[\s\S]*filters/i);
    expect(source).toContain("99+");
    expect(source).toMatch(/expand[\s\S]*JSON payload/i);
  });

  it("documents exact-match webhook subscriptions and delivery health", () => {
    const source = section("operating-webhooks-and-external-notifications.tsx");

    for (const token of [
      "create_webhook",
      "list_webhooks",
      "get_webhook",
      "update_webhook",
      "delete=true",
      "X-Webhook-Signature-256",
      "5-second",
      "10 consecutive failures",
      "last_delivered_at",
      "failure_count",
    ]) {
      expect(source, token).toContain(token);
    }

    expect(source).toMatch(/exact event names/i);
    expect(source).toMatch(/recoverable[\s\S]*not an[\s\S]*hashed/i);
    expect(source).toMatch(
      /webhook mutation routes[\s\S]*no[\s\S]*minimum role/i,
    );
    expect(source).toContain("owner, admin, member, or viewer");
    expect(source).not.toContain("fnmatch");
    expect(source).not.toContain("activity.card.*");
    expect(source).not.toContain("<code>*</code>");
    expect(source).not.toContain("stores the secret hashed");
  });

  it("lists the eight current board tabs, including Timeline", () => {
    const source = section("core-concepts-workspaces-boards-columns-cards.tsx");

    expect(source).toMatch(/eight tabs/i);
    expect(source).toMatch(/history[\s\S]*timeline[\s\S]*git[\s\S]*alerts/i);
    expect(source).toMatch(/Resources page[\s\S]*Resources tab/i);
  });
});
