// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import { installNavigationFixture, noteHref, notePath, originalNoteTitle, type NavigationFixture } from "./fixtures/uxc-navigation-fixture";

test.skip(process.env.BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE !== "1", "Set BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE=1 for synthetic built-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(60_000);

const sources = [
  "e2e/uxc-navigation-hydration.spec.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "src/main.tsx", "src/App.tsx", "src/components/layout/AppShell.tsx", "src/pages/WorkspaceLayout.tsx",
  "src/features/notifications/api/use-current-user.ts", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/providers/NavigationGuardProvider.tsx", "src/providers/ReturnNavigationProvider.tsx",
  "src/features/notes/components/NoteList.tsx", "src/features/notes/components/NoteEditor.tsx",
];
const inputHashes = () => Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))]));
interface HydrationEvidence {
  state: NavigationFixture;
  before: ReturnType<typeof inputHashes>;
  release: () => void;
  identity: { requested: number; released: number | null; responded: number | null }[];
  observations: Record<string, unknown>;
}
const evidence = new Map<Page, HydrationEvidence>();

test.afterEach(async ({ page }, info) => {
  const captured = evidence.get(page);
  if (!captured) return;
  captured.release();
  captured.state.release();
  await Promise.all(captured.state.pendingAssets);
  const after = inputHashes();
  const ledger = info.outputPath("hydration-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Synthetic HTTP/WebSocket responses through actual built AppShell; no deployed authorization or server persistence claim",
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    inputsBefore: captured.before, inputsAfter: after, builtAssets: captured.state.assets,
    identity: captured.identity, observations: captured.observations,
    requests: captured.state.requests, sockets: captured.state.socketLedger,
    failures: captured.state.failures, unexpected: captured.state.unexpected, consoleErrors: captured.state.consoleErrors,
  }, null, 2));
  await info.attach("hydration-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  if (info.status === info.expectedStatus) {
    expect(after).toEqual(captured.before);
    expect(captured.state.unexpected).toEqual([]);
    expect(captured.state.failures).toEqual([]);
    expect(captured.state.assets.some((asset) => asset.path.endsWith(".js") && asset.status === 200)).toBe(true);
  }
  evidence.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`en ${width} initial identity hydration`, () => {
    test.use({ hasTouch: width === 390 });
    test("A01 D3 keeps an edited authorized note when the delayed first identity response arrives", async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const before = inputHashes();
      const state = await installNavigationFixture(page, "en");
      let releaseIdentity: () => void = () => {};
      const pendingIdentity = new Promise<void>((resolve) => { releaseIdentity = resolve; });
      const captured: HydrationEvidence = { state, before, release: releaseIdentity, identity: [], observations: {} };
      evidence.set(page, captured);
      // Delay only delivery: the unchanged strict fixture still supplies its
      // usual authorized owner response, with no query-cache or React injection.
      await page.route("**/api/me", async (route) => {
        const receipt = { requested: Date.now(), released: null as number | null, responded: null as number | null };
        captured.identity.push(receipt);
        await pendingIdentity;
        receipt.released = Date.now();
        await route.fallback();
      });
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/api/me") {
          const receipt = captured.identity.find((item) => item.responded === null);
          if (receipt) receipt.responded = Date.now();
        }
      });

      await page.goto(noteHref);
      const editor = page.getByRole("dialog", { name: en.notes.editTitle, exact: true });
      const title = editor.getByRole("textbox", { name: en.cards.titleLabel, exact: true });
      const save = editor.getByRole("button", { name: en.common.save, exact: true });
      await expect(page.getByRole("main")).toBeVisible();
      await expect(title).toHaveValue(originalNoteTitle);
      await expect(editor.locator('[contenteditable="true"]')).toContainText("Synthetic shared note; no operator data.");
      expect(captured.identity).toHaveLength(1);
      expect(captured.identity[0].responded).toBeNull();
      expect(state.requests.some((request) => request.path === notePath && request.status === 200)).toBe(true);
      expect(state.unexpected).toEqual([]);
      const edited = "SYNTHETIC UNSAVED NOTE BEFORE INITIAL IDENTITY";
      if (width === 390) await title.tap();
      else await title.click();
      await title.fill(edited);
      await expect(save).toBeEnabled();
      const origin = await page.evaluate(() => ({ href: location.href, state: history.state }));
      captured.observations.beforeIdentity = { title: await title.inputValue(), saveEnabled: await save.isEnabled(), origin };
      await page.screenshot({ path: test.info().outputPath("dirty-before-identity.png") });

      const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/me");
      releaseIdentity();
      expect((await response).status()).toBe(200);
      // The real account avatar observes the same query. Its initials establish
      // that profile hydration reached React before asserting draft continuity.
      await expect(page.getByRole("button", { name: en.a11y.account.menu, exact: true, includeHidden: true })).toContainText("SO");
      await expect.poll(() => state.inflight).toBe(0);
      captured.observations.afterIdentity = {
        title: await title.inputValue(), saveEnabled: await save.isEnabled(),
        origin: await page.evaluate(() => ({ href: location.href, state: history.state })),
        noteWrites: state.noteWrites.length,
      };
      await page.screenshot({ path: test.info().outputPath("after-identity.png") });
      expect(captured.identity).toHaveLength(1);
      expect(state.unexpected).toEqual([]);
      expect(state.noteWrites).toEqual([]);
      expect(state.requests.filter((request) => request.method !== "GET")).toEqual([]);
      expect(state.requests.filter((request) => /\/contents\/[^/]+\/(body|download)$/.test(request.path))).toEqual([]);
      expect(await page.evaluate(() => ({ href: location.href, state: history.state }))).toEqual(origin);
      await expect(page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true })).toHaveCount(0);
      await expect.soft(title).toHaveValue(edited);
      expect.soft(await save.isEnabled()).toBe(true);
    });
  });
}
