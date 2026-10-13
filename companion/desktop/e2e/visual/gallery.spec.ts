// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`primitives gallery, ${colorScheme}`, () => {
    test.use({ colorScheme });

    test("primitives", async ({ page }) => {
      await page.goto("/e2e/harness/gallery/");
      await expect(page.getByRole("tablist", { name: "Sections" })).toBeVisible();
      await expect(page).toHaveScreenshot(`gallery-primitives-${colorScheme}.png`, { fullPage: true });
    });

    test("sheet", async ({ page }) => {
      await page.goto("/e2e/harness/gallery/?scene=sheet");
      await expect(page.getByRole("dialog", { name: "Bind mobile-app" })).toBeVisible();
      await expect(page).toHaveScreenshot(`gallery-sheet-${colorScheme}.png`);
    });

    test("alert dialog", async ({ page }) => {
      await page.goto("/e2e/harness/gallery/?scene=dialog");
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(page).toHaveScreenshot(`gallery-dialog-${colorScheme}.png`);
    });
  });
}
