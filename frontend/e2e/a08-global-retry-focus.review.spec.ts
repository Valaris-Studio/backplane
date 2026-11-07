// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { discoveryPath, installOwnerDiscoveryFixture, listPath } from "./fixtures/a03-owner-discovery";
import { sha } from "./fixtures/session-window-fixture";

test.skip(process.env.BACKPLANE_E2E_A03_OWNER_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
const manifestPath = process.env.BACKPLANE_E2E_A03_ASSET_MANIFEST;
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) as { tree: string; files: Record<string, string> } : null;
const source = "src/features/sessions/components/GlobalSessionsPage.tsx";
const labels = en.sessions;

for (const refreshFailure of [false, true]) {
  test(`A08 global ${refreshFailure ? "refresh403 preserves Search focus" : "first403 restores heading focus"} after offline Retry and recovery`, async ({ page }, info) => {
    expect(manifest, "Bind the browser run to the preserved production build").not.toBeNull();
    const sourceBefore = sha(readFileSync(source));
    const state = await installOwnerDiscoveryFixture(page, "en");
    state.rows = state.rows.slice(0, 1);
    state.listStatus = refreshFailure ? 200 : 403;
    const attempts: { query: string; released: boolean }[] = [];
    let hold = false;
    const held: (() => void)[] = [];
    const release = () => { hold = false; held.splice(0).forEach((resolve) => resolve()); };
    const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
    // Hold transport only; the existing strict fixture supplies every response.
    await page.route((url) => url.origin === origin && url.pathname === listPath, async (route) => {
      expect(route.request().method()).toBe("GET");
      const attempt = { query: new URL(route.request().url()).search, released: false };
      attempts.push(attempt);
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      attempt.released = true;
      await route.fallback();
    });
    try {
      await page.goto(discoveryPath);
      await expect(page.getByRole("banner")).toBeVisible();
      const main = page.getByRole("main");
      const row = page.locator('a[id^="owner-session-link-"]');
      const alert = main.getByRole("alert");
      const retry = alert.getByRole("button", { name: labels.loadError.retry, exact: true });
      const search = main.getByRole("textbox", { name: labels.filters.search, exact: true });
      if (refreshFailure) {
        await expect(row).toHaveCount(1);
        state.listStatus = 403;
        await main.getByRole("button", { name: labels.discovery.refresh, exact: true }).click();
      }
      await expect(alert).toContainText(labels.discovery.accessLost);
      await expect(row).toHaveCount(0);
      await retry.focus();
      const original = await retry.elementHandle();
      const before = attempts.length;
      hold = true;
      await page.context().setOffline(true);
      await page.keyboard.press("Enter");
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).not.toHaveAttribute("disabled");
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(attempts).toHaveLength(before);
      await page.context().setOffline(false);
      await expect.poll(() => held.length).toBe(1);
      await expect(retry).toBeFocused();
      expect(await retry.evaluate((button, previous) => button === previous, original)).toBe(true);
      await expect(alert).toContainText(labels.discovery.accessLost);
      await expect(alert).not.toContainText(labels.discovery.loadError);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(attempts).toHaveLength(before + 1);
      release();
      await expect(retry).not.toHaveAttribute("aria-busy", "true");
      await expect(retry).toBeFocused();
      await expect(alert).toContainText(labels.discovery.accessLost);
      state.listStatus = 200; hold = true;
      await page.keyboard.press("Enter");
      await expect.poll(() => held.length).toBe(1);
      if (refreshFailure) await search.click();
      release();
      await expect(row).toHaveCount(1);
      await expect(retry).toHaveCount(0);
      await expect(refreshFailure ? search : main.getByRole("heading", { name: labels.discovery.allSessions, exact: true })).toBeFocused();
      expect(attempts).toHaveLength(before + 2);
      expect(new Set(attempts.map(({ query }) => query)).size).toBe(1);
      expect(state.discoveryReads.filter(({ path }) => path === listPath).map(({ status }) => status))
        .toEqual(refreshFailure ? [200, 403, 403, 200] : [403, 403, 200]);
    } finally {
      release(); state.releaseDiscovery(); state.release();
      await page.context().setOffline(false);
      await expect.poll(() => state.inflight).toBe(0);
      await Promise.all([...state.pendingAssets, ...state.pendingResponses]);
      const assets = state.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] }));
      await info.attach("global-retry-ledger", { contentType: "application/json", body: JSON.stringify({
        tree: manifest?.tree, sourceBefore, sourceAfter: sha(readFileSync(source)), attempts, assets,
        requests: state.requests, responses: state.apiResponses, console: state.consoleEntries, unexpected: state.unexpected,
      }, null, 2) });
      await page.screenshot({ path: info.outputPath("final-shell.png") });
      expect(sha(readFileSync(source))).toBe(sourceBefore);
      expect(state.unexpected).toEqual([]);
      expect(state.requests.filter(({ method }) => method !== "GET")).toEqual([]);
      expect(state.requests.filter(({ path }) => /\/(sessions|notes|cards)\//.test(path))).toEqual([]);
      expect(state.socketsOpened).toBe(0);
      expect(state.failures).toEqual([]);
      expect(state.consoleEntries.filter(({ text, url }) => !text.includes("status of 403") || new URL(url).pathname !== listPath)).toEqual([]);
      expect(assets.some(({ path }) => path.endsWith(".js"))).toBe(true);
      expect(assets.some(({ path }) => path.endsWith(".css"))).toBe(true);
      expect(assets.every((asset) => asset.status === 200 && asset.sha256 === asset.expected)).toBe(true);
    }
  });
}
