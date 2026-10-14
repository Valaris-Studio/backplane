// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

import { AGENTS_HARNESS_NOW, type AgentsHarnessScenario } from "./agents-harness/scenarios";

const agentRow = (page: Page, name: string) =>
  page.getByRole("list", { name: "Coding agents on this Mac" }).locator(":scope > li").filter({ has: page.getByRole("heading", { level: 4, name, exact: true }) });

// What each DK-0 Agents scenario must show before its screenshot is taken.
const READY: Record<AgentsHarnessScenario, (page: Page) => Promise<void>> = {
  healthy: async (page) => {
    await expect(agentRow(page, "Claude Code")).toContainText("1 session now · last upload 8 s ago");
    await expect(agentRow(page, "Codex").getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(agentRow(page, "Pi")).toContainText("Not installed");
  },
  trouble: async (page) => {
    await expect(page.getByRole("button", { name: "Repair" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show in Finder" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Capture Pi sessions" })).toHaveAttribute("aria-checked", "false");
  },
  idle: async (page) => {
    await expect(agentRow(page, "Codex")).toContainText("Capturing");
    await expect(page.getByRole("switch")).toHaveCount(3);
  },
  restart: async (page) => {
    await expect(agentRow(page, "Codex").getByRole("list", { name: "How to restart Codex" })).toBeVisible();
    await expect(page.getByText("One agent needs your attention")).toBeVisible();
  },
  trustRestart: async (page) => {
    await expect(agentRow(page, "Codex").getByRole("list", { name: "How to approve Codex’s hooks" })).toBeVisible();
    await expect(agentRow(page, "Codex").getByRole("list", { name: "How to restart Codex" })).toBeVisible();
  },
  brokenCauses: async (page) => {
    await expect(agentRow(page, "Claude Code")).toContainText("~/.claude/settings.json can’t be read.");
    await expect(agentRow(page, "Codex").getByRole("button", { name: "Repair" })).toBeVisible();
    await expect(agentRow(page, "Pi")).toContainText("Extension replaced");
  },
  daemonRestart: async (page) => {
    await expect(agentRow(page, "Codex").getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(page.getByText("One agent needs your attention")).toBeVisible();
  },
};

async function openScenario(page: Page, scenario: AgentsHarnessScenario) {
  await page.clock.setFixedTime(AGENTS_HARNESS_NOW);
  await page.goto(`/e2e/visual/agents-harness/?scenario=${scenario}`);
  await page.getByRole("tab", { name: /Agents/ }).click();
  await READY[scenario](page);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`agents, ${colorScheme}`, () => {
    test.use({ colorScheme });

    for (const scenario of Object.keys(READY) as AgentsHarnessScenario[]) {
      test(scenario, async ({ page }) => {
        await openScenario(page, scenario);
        await expect(page).toHaveScreenshot(`agents-${scenario}-${colorScheme}.png`);
      });
    }
  });
}

test("the capture switch is reachable by keyboard", async ({ page }) => {
  await openScenario(page, "idle");
  const claudeSwitch = page.getByRole("switch", { name: "Capture Claude Code sessions" });
  await claudeSwitch.focus();
  await expect(claudeSwitch).toBeFocused();
});
