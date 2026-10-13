// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`shell, ${colorScheme}`, () => {
    test.use({ colorScheme });

    test("capturing", async ({ page }) => {
      await page.goto("/e2e/harness/?scenario=home");
      await expect(page.getByTestId("status-header")).toContainText("Capturing");
      await expect(page.getByRole("tab", { name: "Projects, 1 not captured yet" })).toBeVisible();
      await expect(page.getByTestId("screen-home")).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-capturing-${colorScheme}.png`);
    });

    test("paused", async ({ page }) => {
      await page.goto("/e2e/harness/?scenario=paused");
      await expect(page.getByTestId("status-header")).toContainText("Nothing is recorded until you resume");
      await expect(page.getByRole("button", { name: "Resume capture" })).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-paused-${colorScheme}.png`);
    });

    test("onboarding", async ({ page }) => {
      await page.goto("/e2e/harness/?scenario=onboarding");
      await expect(page.getByTestId("screen-onboarding")).toBeVisible();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`shell-onboarding-${colorScheme}.png`);
    });
  });
}

test("not-running replaces the shell", async ({ page }) => {
  await page.goto("/e2e/harness/?scenario=not-running");
  await expect(page.getByRole("heading", { name: "Companion isn't running" })).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
});

test("settings pushes over the tabs and pops back", async ({ page }) => {
  await page.goto("/e2e/harness/?scenario=home");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tablist", { name: "Sections" })).toBeVisible();
});
