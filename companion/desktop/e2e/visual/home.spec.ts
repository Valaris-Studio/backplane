// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

import { HOME_HARNESS_NOW, type HomeScenario } from "./home-harness/scenarios";

// What each scenario must show before its screenshot is taken.
const READY: Record<HomeScenario, (page: Page) => Promise<void>> = {
  capturing: (page) => expect(page.getByRole("list", { name: "Live now" }).getByRole("listitem")).toHaveCount(2),
  attention: (page) => expect(page.getByRole("button", { name: "Show me how" })).toBeVisible(),
  paused: (page) => expect(page.getByText("Capture is paused")).toBeVisible(),
  "paused-server": (page) => expect(page.getByRole("button", { name: "Open device page" })).toBeVisible(),
  offline: (page) => expect(page.getByText("Retrying automatically.")).toBeVisible(),
  revoked: (page) => expect(page.getByRole("button", { name: "Connect again" })).toBeVisible(),
  empty: (page) => expect(page.getByRole("heading", { name: "No sessions yet" })).toBeVisible(),
  usage: (page) => expect(page.getByText("Counting tokens…")).toBeVisible(),
  busy: (page) => expect(page.getByRole("list", { name: "Earlier today" }).getByRole("listitem")).toHaveCount(6),
};

async function openScenario(page: Page, scenario: HomeScenario) {
  await page.clock.setFixedTime(HOME_HARNESS_NOW);
  await page.goto(`/e2e/visual/home-harness/?scenario=${scenario}`);
  await READY[scenario](page);
}

const firstLiveRowTrigger = (page: Page) => page.getByRole("list", { name: "Live now" }).getByRole("listitem").first().getByRole("button").first();

test.use({ timezoneId: "UTC" });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`home, ${colorScheme}`, () => {
    test.use({ colorScheme });

    for (const scenario of Object.keys(READY) as HomeScenario[]) {
      test(scenario, async ({ page }) => {
        await openScenario(page, scenario);
        await expect(page).toHaveScreenshot(`home-${scenario}-${colorScheme}.png`);
      });
    }

    test("capturing, a row expanded", async ({ page }) => {
      await openScenario(page, "capturing");
      const firstRow = firstLiveRowTrigger(page);
      await firstRow.click();
      await expect(page.getByRole("button", { name: "Open in Backplane" })).toBeVisible();
      await expect(page).toHaveScreenshot(`home-capturing-expanded-${colorScheme}.png`);
    });

    test("busy, filtered by a query and sorted by cost with the menu open", async ({ page }) => {
      await openScenario(page, "busy");
      await page.getByRole("searchbox", { name: "Filter sessions by repository, board or agent" }).fill("store");
      await page.getByRole("button", { name: /^Sort sessions:/ }).click();
      await page.getByRole("menuitemradio", { name: "Cost, highest first" }).click();
      await expect(page.getByRole("list", { name: "Earlier today" }).getByRole("listitem")).toHaveCount(2);
      await page.getByRole("button", { name: /^Sort sessions:/ }).click();
      await page.getByRole("menuitemradio", { name: "Cost, highest first" }).hover();
      await expect(page.getByText("Totals below always count all of today.")).toBeVisible();
      await expect(page).toHaveScreenshot(`home-busy-filtered-${colorScheme}.png`);
    });

    test("busy, no session matches a solo and a query", async ({ page }) => {
      await openScenario(page, "busy");
      await page.getByRole("button", { name: "Only Codex" }).click();
      await page.getByRole("searchbox", { name: "Filter sessions by repository, board or agent" }).fill("mobile");
      await expect(page.getByText("Nothing today from Codex matches “mobile”.")).toBeVisible();
      await expect(page).toHaveScreenshot(`home-busy-no-results-${colorScheme}.png`);
    });

    test("usage, a re-cached row expanded with a figure's tip showing", async ({ page }) => {
      await openScenario(page, "usage");
      await page.getByRole("list", { name: "Live now" }).getByRole("listitem").filter({ hasText: "valaris/backplane" }).getByRole("button").first().click();
      await expect(page.getByText("Context re-cached after a pause — the whole conversation was re-sent.")).toBeVisible();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("tooltip", { name: /read back from the prompt cache/ })).toBeVisible();
      await expect(page).toHaveScreenshot(`home-usage-expanded-tip-${colorScheme}.png`);
    });
  });
}

test("Show me how opens the Agents tab", async ({ page }) => {
  await openScenario(page, "attention");
  await page.getByRole("button", { name: "Show me how" }).click();
  await expect(page.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
});

test("a row expands from the keyboard and keeps focus on its trigger", async ({ page }) => {
  await openScenario(page, "capturing");
  const trigger = firstLiveRowTrigger(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toBeFocused();
});

test("the toolbar stays pinned while a busy day scrolls under it", async ({ page }) => {
  await openScenario(page, "busy");
  const toolbar = page.getByRole("search", { name: "Sessions" });
  const before = await toolbar.boundingBox();
  await page.locator("#shell-panel").evaluate((panel) => panel.scrollTo(0, panel.scrollHeight));
  const after = await toolbar.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? Number.NaN, 0);
});

test("Escape in the filter clears it and keeps the window's content", async ({ page }) => {
  await openScenario(page, "busy");
  const field = page.getByRole("searchbox", { name: "Filter sessions by repository, board or agent" });
  await page.keyboard.press("/");
  await expect(field).toBeFocused();
  await page.keyboard.type("docs");
  await expect(page.getByRole("list", { name: "Earlier today" }).getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(page.getByRole("list", { name: "Earlier today" }).getByRole("listitem")).toHaveCount(6);
});

test("the footer stays pinned under the scrolling list", async ({ page }) => {
  await openScenario(page, "capturing");
  const footer = page.getByRole("group", { name: "Today’s totals" });
  const box = await footer.boundingBox();
  expect(box && box.y + box.height).toBeGreaterThan(500);
});
