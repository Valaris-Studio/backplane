// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

// A fixed clock keeps the Switch server countdown on one frame.
const FROZEN_NOW = new Date("2026-10-08T10:00:00Z");

async function openSettings(page: Page, query = "") {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/e2e/visual/settings-harness/${query}`);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Open at login" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Channel" })).toBeEnabled();
}

test.use({ contextOptions: { reducedMotion: "reduce" } });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`settings, ${colorScheme}`, () => {
    test.use({ colorScheme });

    test("settings", async ({ page }) => {
      await openSettings(page);
      await expect(page).toHaveScreenshot(`settings-${colorScheme}.png`);
    });

    test("settings, scrolled to the end", async ({ page }) => {
      await openSettings(page);
      await page.locator("#shell-panel").evaluate((panel) => panel.scrollTo(0, panel.scrollHeight));
      await expect(page.getByRole("button", { name: "Remove…" })).toBeInViewport();
      await expect(page).toHaveScreenshot(`settings-end-${colorScheme}.png`);
    });

    test("update available", async ({ page }) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Check now" }).click();
      await expect(page.getByText("Companion 0.9.0 is ready")).toBeVisible();
      await page.locator("#shell-panel").evaluate((panel) => panel.scrollTo(0, 0));
      await expect(page).toHaveScreenshot(`settings-update-${colorScheme}.png`);
    });

    test("sign out confirmation", async ({ page }) => {
      await openSettings(page, "?waiting=3");
      await page.getByRole("button", { name: "Sign out…" }).click();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(page).toHaveScreenshot(`settings-sign-out-${colorScheme}.png`);
    });

    test("switch server: address", async ({ page }) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Switch server…" }).click();
      await page.getByRole("textbox", { name: "Server address" }).fill("https://intern.backplane.example");
      await expect(page).toHaveScreenshot(`settings-switch-server-${colorScheme}.png`);
    });

    test("switch server: code", async ({ page }) => {
      await openSettings(page, "?waiting=3");
      await page.getByRole("button", { name: "Switch server…" }).click();
      await page.getByRole("textbox", { name: "Server address" }).fill("https://intern.backplane.example");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("group", { name: "Code KMTR-XQBW" })).toBeFocused();
      await expect(page).toHaveScreenshot(`settings-switch-code-${colorScheme}.png`);
    });

    test("switch server: approved, switching", async ({ page }) => {
      await openSettings(page, "?waiting=3&switch=switching");
      await page.getByRole("button", { name: "Switch server…" }).click();
      await page.getByRole("textbox", { name: "Server address" }).fill("https://intern.backplane.example");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Switching to intern.backplane.example.", { exact: false })).toBeVisible();
      await expect(page).toHaveScreenshot(`settings-switch-switching-${colorScheme}.png`);
    });

    test("switch server: done, old server unreachable", async ({ page }) => {
      await openSettings(page, "?switch=approved-offline");
      await page.getByRole("button", { name: "Switch server…" }).click();
      await page.getByRole("textbox", { name: "Server address" }).fill("https://intern.backplane.example");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("button", { name: "Done" })).toBeFocused();
      await expect(page).toHaveScreenshot(`settings-switch-done-offline-${colorScheme}.png`);
    });

    test("remove confirmation", async ({ page }) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Remove…" }).click();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(page).toHaveScreenshot(`settings-remove-${colorScheme}.png`);
    });

    test("companion removed", async ({ page }) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Remove…" }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Backplane Companion was removed from this Mac" })).toBeVisible();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`settings-removed-${colorScheme}.png`);
    });

    test("removal incomplete", async ({ page }) => {
      await openSettings(page, "?removal=incomplete");
      await page.getByRole("button", { name: "Remove…" }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.getByRole("alertdialog").getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Removal may not have finished" })).toBeVisible();
      await expect(page).toHaveScreenshot(`settings-removal-incomplete-${colorScheme}.png`);
    });

    test("renaming", async ({ page }) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Rename…" }).click();
      await page.getByRole("textbox", { name: /Device name/ }).fill("");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("The name can’t be empty.")).toBeVisible();
      await expect(page).toHaveScreenshot(`settings-rename-error-${colorScheme}.png`);
    });
  });
}

test("Escape in the rename field cancels it and focus returns to Rename", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Rename…" }).click();
  await expect(page.getByRole("textbox", { name: /Device name/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Rename…" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});
