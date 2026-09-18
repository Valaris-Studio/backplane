// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };

test.use({ storageState: process.env.BACKPLANE_E2E_STORAGE_STATE });

test("mobile shell preserves controls and confines board scrolling", async ({ page }) => {
  const slug = `mobile-gate-${Date.now()}`;
  expect((await page.request.post("/api/workspaces", { data: { name: slug, slug } })).status()).toBe(201);
  try {
    const response = await page.request.post(`/api/workspaces/${slug}/boards`, { data: { name: "Mobile board" } });
    expect(response.status()).toBe(201);
    const board = await response.json();

    for (const [language, labels] of [["en", en], ["es", es], ["pt-BR", pt]] as const) {
      await page.addInitScript((locale) => localStorage.setItem("i18n-lang", locale), language);
      // 640 CSS pixels also exercises reflow at the width of a 1280px window at 200% zoom.
      for (const width of [320, 390, 640]) {
        await page.setViewportSize({ width, height: 844 });
        for (const route of [`/${slug}/resources`, `/${slug}/boards/${board.id}/kanban`]) {
          await page.goto(route);
          await expect(page.getByRole("heading", { name: route.endsWith("/kanban") ? /^Mobile board/ : labels.resources.workspaceTitle })).toBeVisible();
          const account = page.getByRole("button", { name: labels.a11y.account.menu, exact: true });
          await expect(account).toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          for (const control of [account, page.getByRole("button", { name: labels.a11y.topbar.toggleSidebar })]) {
            const bounds = await control.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          }
          await page.locator("header summary").focus();
          await page.keyboard.press("Enter");
          const languageSelect = page.getByRole("combobox", { name: labels.a11y.languageSwitcher });
          await expect(languageSelect).toBeVisible();
          if (width === 320 && route.endsWith("/resources")) await page.screenshot({ path: test.info().outputPath(`${language}-controls.png`) });
          await languageSelect.selectOption(language);
          await page.keyboard.press("Escape");
          await expect(languageSelect).not.toBeVisible();
          await account.click();
          await expect(page.getByRole("menuitem").first()).toBeVisible();
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: labels.a11y.topbar.toggleSidebar }).click();
          await expect(page.getByRole("button", { name: labels.a11y.sidebar.closeMobile })).toBeVisible();
          await page.getByRole("button", { name: labels.a11y.sidebar.closeMobile }).click({ position: { x: width - 8, y: 100 } });
          await expect(page.getByRole("button", { name: labels.a11y.sidebar.closeMobile })).not.toBeVisible();
          if (route.endsWith("/kanban")) {
            // The board remains wider than its own viewport, without widening the document.
            const localScrollers = await page.locator("main .overflow-x-auto").evaluateAll((nodes) =>
              nodes.filter((node) => node.scrollWidth > node.clientWidth).length,
            );
            expect(localScrollers).toBeGreaterThan(0);
          }
          if (width === 320) await page.screenshot({ path: test.info().outputPath(`${language}-${route.endsWith("/kanban") ? "kanban" : "resources"}.png`) });
        }
      }
    }
  } finally {
    expect((await page.request.delete(`/api/workspaces/${slug}`)).status()).toBe(204);
  }
});
