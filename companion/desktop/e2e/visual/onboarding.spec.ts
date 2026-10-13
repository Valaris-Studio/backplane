// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

// Date.now stays put (a countdown that ticks would never match a baseline); timers still run.
const FIXED_NOW = new Date("2026-09-28T10:00:00Z");

async function open(page: Page, scenario: string) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`/e2e/visual/onboarding-harness/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "See which sessions worked on which card" })).toBeVisible();
}

const heading = (page: Page, name: string) => page.locator('[data-view]:not([data-leaving="true"])').getByRole("heading", { level: 1, name });
const button = (page: Page, name: string) => page.locator('[data-view]:not([data-leaving="true"])').getByRole("button", { name, exact: true });

const SERVER = "https://backplane.northwind.dev";

async function toServer(page: Page) {
  await button(page, "Get started").click();
  await expect(heading(page, "Where is your Backplane?")).toBeFocused();
}

async function enterServer(page: Page) {
  await page.getByRole("textbox", { name: "Server address" }).fill(SERVER);
}

async function toCode(page: Page) {
  await toServer(page);
  await enterServer(page);
  await button(page, "Continue").click();
  await expect(heading(page, "Approve this Mac in Backplane")).toBeVisible();
}

async function toAgents(page: Page) {
  await toCode(page);
  await expect(heading(page, "Capture from these agents")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Capture Claude Code sessions" })).toBeVisible();
}

async function toProjectsStep(page: Page) {
  await toAgents(page);
  await button(page, "Continue").click();
  await expect(heading(page, "Bind your first projects")).toBeVisible();
}

async function toProjects(page: Page) {
  await toProjectsStep(page);
  await expect(page.getByRole("listitem", { name: "backplane" })).toBeVisible();
}

const SCENARIOS: Record<string, (page: Page) => Promise<void>> = {
  welcome: async () => {},
  server: toServer,
  "server-filled": async (page) => {
    await toServer(page);
    await enterServer(page);
  },
  "server-empty": async (page) => {
    await toServer(page);
    await button(page, "Continue").click();
    await expect(page.getByText("Enter your server’s address.")).toBeVisible();
  },
  "server-unnamed": toServer,
  "server-name-invalid": async (page) => {
    await toServer(page);
    await enterServer(page);
    await page.getByRole("textbox", { name: "Device name" }).fill("Tester’s MacBook Pro\u202e");
    await button(page, "Continue").click();
    await expect(page.getByText("Use letters, numbers, spaces and punctuation only.")).toBeVisible();
  },
  code: async (page) => {
    await toCode(page);
    await expect(page.getByText("Waiting for you to approve in Backplane")).toBeVisible();
  },
  "code-expired": async (page) => {
    await toCode(page);
    await expect(page.getByTestId("screen-onboarding").getByRole("alert")).toContainText("This code expired");
  },
  "code-denied": async (page) => {
    await toCode(page);
    await expect(page.getByTestId("screen-onboarding").getByRole("alert")).toContainText("The request was declined in Backplane");
  },
  "code-offline": async (page) => {
    await toCode(page);
    await expect(page.getByText("Can’t reach the server. Retrying on its own.")).toBeVisible();
  },
  agents: toAgents,
  "agents-restart": async (page) => {
    await toAgents(page);
    await expect(page.getByRole("list", { name: "How to restart Codex" })).toBeVisible();
  },
  projects: toProjects,
  "projects-empty": async (page) => {
    await toProjectsStep(page);
    await expect(button(page, "Add a folder…")).toBeVisible();
  },
  "projects-no-boards": async (page) => {
    await toProjects(page);
    await page.getByRole("listitem", { name: "dotfiles" }).getByRole("button", { name: "Choose board…" }).click();
    const sheet = page.getByRole("dialog", { name: "Bind dotfiles" });
    await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await expect(sheet.getByRole("button", { name: "Open Backplane to create a board" })).toBeVisible();
    // Clicking the row's button can scroll the step behind the scrim by a varying amount.
    await page.evaluate(() => document.querySelectorAll("*").forEach((element) => element.scrollTo(0, 0)));
  },
  done: async (page) => {
    await toProjects(page);
    await button(page, "Continue").click();
    await expect(heading(page, "You’re set")).toBeVisible();
  },
};

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`onboarding, ${colorScheme}`, () => {
    test.use({ colorScheme });

    for (const [scenario, reach] of Object.entries(SCENARIOS)) {
      test(scenario, async ({ page }) => {
        await open(page, scenario);
        await reach(page);
        await expect(page.locator("[data-leaving]")).toHaveCount(0);
        await expect(page).toHaveScreenshot(`onboarding-${scenario}-${colorScheme}.png`);
      });
    }
  });
}

test("Continue is usable again after Back abandoned a pairing that is still starting", async ({ page }) => {
  await open(page, "slow-start");
  await toServer(page);
  await enterServer(page);
  await button(page, "Continue").click();
  await expect(button(page, "Continue")).toHaveAttribute("aria-busy", "true");
  await button(page, "Back").click();
  await button(page, "Get started").click();
  await expect(heading(page, "Where is your Backplane?")).toBeFocused();
  await expect(button(page, "Continue")).not.toHaveAttribute("aria-busy", "true");
  await enterServer(page);
  await button(page, "Continue").click();
  await expect(heading(page, "Approve this Mac in Backplane")).toBeVisible();
});
