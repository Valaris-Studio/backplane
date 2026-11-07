// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "@playwright/test";
import { installOwnerDiscoveryFixture } from "./fixtures/a03-owner-discovery";
import { originalNoteTitle } from "./fixtures/uxc-navigation-fixture";

test.skip(process.env.BACKPLANE_E2E_HOME_COMPACT !== "1", "Requires isolated Home fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

for (const variant of [
  { name: "desktop-light", width: 1440, height: 900, locale: "en", theme: "light" },
  { name: "desktop-dark-es", width: 1440, height: 900, locale: "es", theme: "dark" },
  { name: "narrow-light-pt", width: 390, height: 844, locale: "pt-BR", theme: "light" },
  { name: "narrow-dark", width: 390, height: 844, locale: "en", theme: "dark" },
]) {
  test(`${variant.name}: latest three, compact workspace hierarchy and keyboard disclosure`, async ({ page }, info) => {
    await page.setViewportSize({ width: variant.width, height: variant.height });
    const state = await installOwnerDiscoveryFixture(page, variant.locale);
    await page.addInitScript((theme) => localStorage.setItem("valaris-theme", theme), variant.theme);
    state.rows[0]!.title = "Review the latest frontend continuity changes and keep workspace selection visible while navigating related captured evidence";
    state.rows[0]!.repository = "https://github.com/Valaris-Studio/backplane";
    state.rows[0]!.branch = "feature/long-branch-name-that-must-not-expand-the-page";
    state.rows[0]!.harness = "codex_cli";
    state.rows[0]!.harness_display_name = "Codex";
    state.rows[6]!.last_event_at = new Date(Date.parse(state.rows[0]!.last_event_at) - 30_000).toISOString();
    const expected = [state.rows[0]!, state.rows[6]!, state.rows[1]!];
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", variant.theme);
    const rows = page.locator('li[id^="owner-session-"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('a[id^="owner-session-link-"]')).toHaveText(expected.map((row) => row.title!));
    await expect(rows.first().getByRole("link", { name: state.rows[0]!.repository!, exact: true })).toBeVisible();
    await expect(rows.first().getByRole("link", { name: state.rows[0]!.branch!, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveCount(0);
    const geometry = await rows.evaluateAll((items) => items.map((item) => ({
      height: item.getBoundingClientRect().height,
      width: item.getBoundingClientRect().width,
    })));
    expect(geometry.every((row) => row.height <= 84)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const workspace = page.locator("[data-workspace-card]").first();
    await expect(workspace).toBeVisible();
    expect((await workspace.boundingBox())!.y).toBeLessThan(variant.height - 80);
    await page.screenshot({ path: info.outputPath("home-collapsed.png"), fullPage: true });
    const linkedRow = page.locator(`#owner-session-${state.rows[1]!.id}`);
    const toggle = linkedRow.getByRole("button", { expanded: false });
    await toggle.press("Enter");
    await expect(linkedRow.getByRole("button", { expanded: true })).toBeFocused();
    await expect(linkedRow.getByRole("link", { name: originalNoteTitle, exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("home-expanded.png"), fullPage: true });
    await linkedRow.getByRole("button", { expanded: true }).press("Space");
    await expect(linkedRow.getByRole("button", { expanded: false })).toBeFocused();
    await expect(page.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveCount(0);
    expect(await page.locator("[data-marquee-track]").count()).toBe(0);
    if (variant.name === "desktop-light") {
      await rows.first().getByRole("link", { name: state.rows[0]!.branch!, exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Search sessions", exact: true })).toHaveValue(state.rows[0]!.branch!);
      await expect(page.locator('a[id^="owner-session-link-"]')).toHaveCount(1);
      await expect(page.locator('a[id^="owner-session-link-"]')).toHaveText(state.rows[0]!.title!);
    }
    await expect.poll(() => state.inflight).toBe(0);
    await Promise.all([...state.pendingAssets, ...state.pendingResponses]);
    expect(state.unexpected).toEqual([]);
    expect(state.consoleEntries).toEqual([]);
    expect(state.requests.some((request) => request.method !== "GET")).toBe(false);
    await info.attach("layout", { body: JSON.stringify({ variant, rows: geometry, expectedIds: expected.map((row) => row.id) }), contentType: "application/json" });
  });
}
