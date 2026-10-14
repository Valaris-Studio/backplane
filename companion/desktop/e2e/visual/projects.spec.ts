// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

import type { ProjectsScenario } from "./projects-harness/scenarios";

const SUB_TAB: Record<ProjectsScenario, RegExp> = {
  bound: /^Bound/,
  "bound-agents": /^Bound/,
  "bound-agents-blocked": /^Bound/,
  found: /^Found/,
  "found-empty": /^Found/,
  "found-scope": /^Found/,
  bind: /^Found/,
  "bind-no-boards": /^Found/,
  ignored: /^Ignored/,
  rules: /^Rules/,
};

// What each scenario must show before its screenshot is taken.
const READY: Record<ProjectsScenario, (page: Page) => Promise<void>> = {
  bound: async (page) => {
    await expect(page.getByRole("list", { name: "Bound folders" }).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("switch", { name: "Let your agents work on this board from backplane" })).toBeVisible();
  },
  "bound-agents": async (page) => {
    const agents = page.getByRole("list", { name: "Agents working from backplane" });
    await expect(agents.locator(":scope > li")).toHaveCount(3);
    await agents.evaluate((list) => list.scrollIntoView({ block: "end" }));
  },
  "bound-agents-blocked": (page) => expect(page.getByRole("button", { name: "Turn it back on" })).toBeVisible(),
  found: (page) => expect(page.getByRole("list", { name: "Found folders" }).getByRole("listitem")).toHaveCount(5),
  "found-empty": (page) => expect(page.getByRole("tabpanel").getByRole("button", { name: "Add a folder…" })).toHaveCount(2),
  // Every bindable row says what its bind covers: by remote, or by path.
  "found-scope": async (page) => {
    const found = page.getByRole("list", { name: "Found folders" });
    await expect(found.getByRole("listitem")).toHaveCount(5);
    const dotfiles = found.getByRole("listitem").filter({ has: page.getByText("dotfiles", { exact: true }) });
    await dotfiles.evaluate((row) => row.scrollIntoView({ block: "start" }));
    await expect(dotfiles.getByText("Binds by remote: any clone of this repo is captured.")).toBeInViewport();
    await expect(found.getByText("Binds by path: only this folder is captured.")).toBeInViewport();
  },
  bind: async (page) => {
    await page.getByRole("button", { name: "Choose board…" }).click();
    const sheet = page.getByRole("dialog", { name: "Bind mobile-app" });
    // The sheet slides in; a click mid-slide scrolls its body, so wait for it to rest.
    await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await sheet.getByRole("option", { name: "Mobile app", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "Bind" })).toBeEnabled();
    await page.locator(".bp-sheet-body").evaluate((body) => body.scrollTo(0, 0));
  },
  "bind-no-boards": async (page) => {
    await page.getByRole("button", { name: "Bind to board…" }).click();
    const sheet = page.getByRole("dialog", { name: "Bind dotfiles" });
    await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await expect(sheet.getByRole("button", { name: "Open Backplane to create a board" })).toBeVisible();
    // Clicking the row's button scrolled the list behind the scrim by a varying amount.
    await page.evaluate(() => document.querySelectorAll("*").forEach((element) => element.scrollTo(0, 0)));
  },
  ignored: (page) => expect(page.getByRole("list", { name: "Ignored folders" }).getByRole("listitem")).toHaveCount(2),
  rules: (page) => expect(page.getByRole("list", { name: "Never capture rules" }).getByRole("listitem")).toHaveCount(2),
};

async function openScenario(page: Page, scenario: ProjectsScenario) {
  const QUERY: Partial<Record<ProjectsScenario, string>> = {
    "bind-no-boards": "?no-boards",
    "found-empty": "?no-found",
    "bound-agents": "?agents",
    "bound-agents-blocked": "?agents-blocked",
  };
  const query = QUERY[scenario] ?? "";
  await page.goto(`/e2e/visual/projects-harness/${query}`);
  await page.getByRole("tab", { name: /^Projects/ }).click();
  // A click that lands mid-slide scrolls the panel; wait until Home has left.
  await expect(page.locator("#shell-panel > [data-view]")).toHaveCount(1);
  await page.getByRole("tab", { name: SUB_TAB[scenario] }).click();
  await expect(page.locator("#projects-panel > [data-view]")).toHaveCount(1);
  await READY[scenario](page);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`projects, ${colorScheme}`, () => {
    test.use({ colorScheme });

    for (const scenario of Object.keys(READY) as ProjectsScenario[]) {
      test(scenario, async ({ page }) => {
        await openScenario(page, scenario);
        await expect(page).toHaveScreenshot(`projects-${scenario}-${colorScheme}.png`);
      });
    }
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`projects bind detail, ${colorScheme}`, () => {
    test.use({ colorScheme });
    test("the bind sheet says what Standard sends, in detail", async ({ page }) => {
      await openScenario(page, "bind");
      const sheet = page.getByRole("dialog", { name: "Bind mobile-app" });
      const detail = sheet.getByRole("button", { name: "What Standard sends, in detail" });
      await detail.click();
      await expect(detail).toHaveAttribute("aria-expanded", "true");
      await expect(sheet.getByRole("list", { name: "Sent" })).toBeVisible();
      // The panel grows open; scroll only once it has settled, or the shot catches it mid-height.
      await expect(sheet.locator("[data-disclosure-panel]")).toHaveCSS("opacity", "1");
      await page.locator(".bp-sheet-body").evaluate((body) => body.scrollTo(0, body.scrollHeight));
      await expect(page).toHaveScreenshot(`projects-bind-detail-${colorScheme}.png`);
    });
  });
}

// Focus return after close is asserted in projects.test.tsx: under the harness's StrictMode the kit's
// useModalFocus skips it (reported to the orchestrator), which production builds do not.
test("the bind sheet's picker works from the keyboard, and Escape clears the search before it closes", async ({ page }) => {
  await openScenario(page, "found");
  const opener = page.getByRole("button", { name: "Bind to board…" });
  await opener.click();
  const search = page.getByRole("combobox", { name: "Search boards" });
  await expect(search).toBeFocused();
  await page.keyboard.type("fleet");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "Fleet portal" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("no path under HOME is shown in full", async ({ page }) => {
  for (const scenario of ["bound", "found", "ignored"] as const) {
    await openScenario(page, scenario);
    await expect(page.locator("body")).not.toContainText("/home/tester");
  }
});
