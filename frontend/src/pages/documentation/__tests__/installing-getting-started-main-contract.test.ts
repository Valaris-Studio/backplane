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
import { RUNNER_RELEASE } from "@/lib/runner-release";

const testDir = dirname(fileURLToPath(import.meta.url));
const section = (slug: string) =>
  readFileSync(join(testDir, "../sections", `${slug}.tsx`), "utf8");

describe("installing and getting-started documentation against main", () => {
  it("documents the source-built three-service Compose core and the runner-profile limitation", () => {
    const source = section("installing-install-with-docker-compose");

    expect(source).toMatch(/three core containers/i);
    expect(source).toContain("pull_policy: build");
    expect(source).toContain("OAUTH_STATE_SIGNING_KEY");
    expect(source).toContain("--email you@example.com");
    expect(source).toMatch(/runner profile[\s\S]*not turnkey/i);
    expect(source).toContain("second mount for that MCP file");
    expect(source).toContain("mcp-config.json");
    expect(source).not.toContain("Docker Engine 24");
    expect(source).not.toContain("BACKPLANE_BACKEND_IMAGE");
    expect(source).not.toContain("four containers");
  });

  it("documents source-checkout upgrades, Alembic verification and honest downtime", () => {
    const source = section("installing-upgrading-backplane");

    expect(source).toContain("build --pull backend frontend");
    expect(source).toContain("python -m alembic current");
    expect(source).toContain("/api/ready");
    expect(source).toMatch(/brief interruption|downtime/i);
    expect(source).not.toContain("docker compose -f docker-compose.prod.yml pull");
    expect(source).not.toContain("Pin your image tags");
    expect(source).not.toContain("You do not need a maintenance window");
  });

  it("documents shipped OIDC and preserves working authentication links", () => {
    const source = section("installing-securing-a-self-hosted-deployment");

    for (const token of [
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_SCOPES",
      "/api/auth/oidc/callback",
      "OAUTH_STATE_SIGNING_KEY",
      "AUTH_AUTO_PROVISION",
    ]) {
      expect(source, token).toContain(token);
    }

    expect(source).toContain("../documentation/api-authentication-modes#oidc-login");
    expect(source).not.toContain("FutureState");
    expect(source).not.toContain("first post-launch milestone");
  });

  it("documents the MCP origin contract, current Claude Code config and exact prompt IDs", () => {
    const source = section("getting-started-installing-the-mcp-server");

    expect(source).toContain('"VALARIS_API_URL": "https://your-backplane-host"');
    expect(source).toContain(".mcp.json");
    expect(source).toContain("@<commit>#subdirectory=mcp-server");

    for (const prompt of [
      "init_project",
      "standup",
      "triage",
      "status",
      "plan_work",
      "decompose_card",
      "sprint",
      "pickup",
      "implement",
      "ship",
    ]) {
      expect(source, prompt).toContain(prompt);
    }

    expect(source).not.toContain("your-backplane-host/api");
    expect(source).not.toContain("claude_code_config.json");
    expect(source).not.toContain("cosmetic drift");
  });

  it("documents the current board defaults and shared Markdown/Mermaid editor", () => {
    const source = section("getting-started-your-first-board-and-card");

    expect(source).toMatch(/To Do[\s\S]*In Progress[\s\S]*Blocked[\s\S]*Done/);
    expect(source).toContain("timeline");
    expect(source).toContain("Markdown");
    expect(source).toContain("Mermaid");
    expect(source).toContain("Export .md");
    expect(source).toMatch(/task[\s\S]*issue[\s\S]*feature[\s\S]*bug/);
    expect(source).not.toContain("chore / spike / doc");
    expect(source).not.toContain("board starts\n        empty");
  });

  it("states that exported runner bundles contain placeholders and require a board", () => {
    const source = section("getting-started-registering-a-runner");

    expect(source).toContain("${`{VALARIS_API_KEY}`}");
    expect(source).toMatch(/at least one board/i);
    expect(source).toMatch(/does not embed|not baked/i);
    expect(source).not.toContain("it embeds the API key");
  });

  it("documents the published v0.8.5 runner distribution and explicit config launch", () => {
    const source = section("getting-started-your-first-pipeline-run");

    expect(source).toContain("storage.googleapis.com/backplane-artifacts/runner/v0.8.5");
    expect(source).toContain("SHA256SUMS");
    expect(source).toMatch(/macOS, Linux, and Windows binaries/);
    expect(source).toContain("backplane-runner-windows-amd64.exe");
    expect(source).toContain("ghcr.io/valaris-studio/backplane-runner:0.8.5");
    expect(source).toContain("-doctor -config runner-laptop-seba.yaml");
    expect(source).toMatch(/polls once immediately/i);
    expect(source).toContain("${`{VALARIS_API_KEY}`}");
    expect(source).not.toContain("Binary distribution is on the roadmap");
    expect(source).not.toContain("Treat the YAML as a secret");
  });

  it("keeps first-run troubleshooting aligned with current authority checks", () => {
    const source = section("getting-started-troubleshooting-your-first-run");

    expect(source).toContain("-doctor -config runner-laptop-seba.yaml");
    expect(source).toContain("health_config_errors");
    expect(source).toMatch(/remains unclaimed/i);
    expect(source).toContain("claude-cli");
    expect(source).toContain("codex-cli");
    expect(source).not.toContain("Scheduling priority excludes the role");
    expect(source).not.toContain("claims fine while");
    expect(source).not.toContain("awaiting prompt");
  });


  it("keeps the walkthrough's download commands on the released runner version", () => {
    const source = section("getting-started-your-first-pipeline-run");

    // RUNNER_RELEASE is the single frontend pin of the released runner —
    // bumping it must drag the walkthrough's curl commands along.
    expect(source).toContain(`runner/v${RUNNER_RELEASE.version}`);
  });

  it.each(["es", "pt-BR"] as const)(
    "keeps every corrected installing and getting-started slug complete in %s",
    (locale) => {
      for (const slug of [
        "install-with-docker-compose",
        "securing-a-self-hosted-deployment",
        "upgrading-backplane",
        "backup-and-restore",
        "creating-your-first-workspace",
        "your-first-board-and-card",
        "installing-the-mcp-server",
        "registering-a-runner",
        "your-first-pipeline-run",
        "troubleshooting-your-first-run",
      ]) {
        expect(
          getMissingDocumentationStrings(locale, slug),
          `${locale}:${slug}:missing`,
        ).toEqual([]);
        expect(
          getUnexpectedDocumentationStrings(locale, slug),
          `${locale}:${slug}:unexpected`,
        ).toEqual([]);
      }
    },
  );
});
