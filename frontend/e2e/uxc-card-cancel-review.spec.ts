// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import { boardPath, cardA, cardB, cardHref, cardNames, installCardNavigationFixture, originalCards, type CardNavigationFixture } from "./fixtures/uxc-card-navigation-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Set BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE=1 for synthetic built-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const fixtureFiles = ["e2e/uxc-card-cancel-review.spec.ts", "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const hashes = () => Object.fromEntries(fixtureFiles.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head?: string; source_manifest?: string; files: Record<string, string> } : null;
const states = new Map<Page, { fixture: CardNavigationFixture; before: ReturnType<typeof hashes>; observations: unknown[] }>();

function editor(page: Page) { return page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true }); }
function body(page: Page) { return editor(page).locator('[contenteditable="true"]'); }
function prompt(page: Page) { return page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true }); }
function cancel(page: Page) { return editor(page).getByRole("button", { name: en.common.cancel, exact: true }); }
function activate(control: Locator, width: number) { return width === 390 ? control.tap() : control.click(); }
const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const entry = (page: Page) => page.evaluate(() => ({ key: history.state.key, idx: history.state.idx }));

async function unloadWarns(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function observation(page: Page, name: string) {
  const state = states.get(page)!;
  const title = editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true, includeHidden: true });
  const value = {
    name, url: page.url(), history: await entry(page),
    title: await title.count() ? await title.inputValue() : null,
    body: await body(page).count() ? await body(page).textContent() : null,
    editorVisible: await editor(page).isVisible(),
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 160), insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]') })),
    unloadWarns: await unloadWarns(page), writes: structuredClone(state.fixture.cardWrites),
  };
  state.observations.push(value);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return value;
}

async function settled(state: CardNavigationFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function openA(page: Page, width: number) {
  await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
  await expect.poll(() => path(page)).toBe(cardHref(cardA));
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(cardNames[cardA]);
  await expect(body(page)).toBeVisible();
}

async function nativeReloadWarns(page: Page) {
  const originalURL = page.url();
  const document = await page.evaluateHandle(() => window.document);
  const warning = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  expect(page.url()).toBe(originalURL);
  expect(await document.evaluate((prior) => prior === window.document)).toBe(true);
  await document.dispose();
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA();
  state.fixture.release();
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const after = hashes();
  const ledger = info.outputPath("card-cancel-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Actual preserved built AppShell/BoardView/RichTextEditor and footer Cancel; synthetic HTTP/WebSocket, not live authority or persistence proof",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    sourceBase: manifest?.head, sourceManifest: manifest?.source_manifest,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    actualTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    fixtureInputsBefore: state.before, fixtureInputsAfter: after,
    currentSourceContextOnly: sha(readFileSync("src/features/kanban/components/BoardView.tsx")),
    builtAssets: assets, observations: state.observations, requests: state.fixture.requests,
    sockets: state.fixture.socketLedger, unexpected: state.fixture.unexpected,
    failures: state.fixture.failures, consoleErrors: state.fixture.consoleErrors,
    cardWrites: state.fixture.cardWrites, savedCards: [...state.fixture.cards.values()], status: info.status,
  }, null, 2));
  await info.attach("card-cancel-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  expect.soft(state.fixture.unexpected).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(after).toEqual(state.before);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`${width} footer Cancel`, () => {
    test.use({ hasTouch: width === 390 });
    test("clean Cancel closes; dirty Cancel retains A until Keep editing, Save or Discard consent", async ({ page }) => {
      expect(manifest, "Require the exact root-supplied preserved build manifest").not.toBeNull();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const state = await installCardNavigationFixture(page);
      states.set(page, { fixture: state, before: hashes(), observations: [] });
      await page.goto(boardPath);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
      await settled(state);
      await openA(page, width);
      await expect(editor(page).getByRole("button", { name: en.common.save, exact: true })).toBeDisabled();
      await activate(cancel(page), width);
      await expect.poll(() => path(page)).toBe(boardPath);
      await expect(editor(page)).toBeHidden();
      await expect(prompt(page)).toBeHidden();
      expect(state.cardWrites).toEqual([]);
      expect(await unloadWarns(page)).toBe(false);
      await observation(page, "clean-cancel-control");

      await openA(page, width);
      const origin = await entry(page);
      const draft = `SYNTHETIC FOOTER CANCEL DRAFT A ${width}`;
      await body(page).fill(draft);
      expect(await unloadWarns(page)).toBe(true);
      await activate(cancel(page), width);
      await expect(prompt(page)).toBeVisible();
      const blocked = await observation(page, "dirty-cancel-before-consent");
      expect(path(page)).toBe(cardHref(cardA));
      expect(await entry(page)).toEqual(origin);
      expect(state.cardWrites).toEqual([]);
      expect.soft(blocked.editorVisible).toBe(true);
      expect.soft(blocked.title).toBe(cardNames[cardA]);
      expect.soft(blocked.body).toBe(draft);
      expect.soft(blocked.unloadWarns).toBe(true);
      await expect(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true })).toBeFocused();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await expect(prompt(page)).toBeHidden();
      await observation(page, "after-keep-editing");
      await expect(editor(page)).toBeVisible();
      await expect(body(page)).toHaveText(draft);
      expect(path(page)).toBe(cardHref(cardA));
      expect(await entry(page)).toEqual(origin);
      await expect.poll(() => editor(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await nativeReloadWarns(page);

      await activate(cancel(page), width);
      await expect(prompt(page)).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.save, exact: true }), width);
      await expect.poll(() => path(page)).toBe(boardPath);
      await expect(editor(page)).toBeHidden();
      await settled(state);
      expect(state.cardWrites).toHaveLength(1);
      expect(state.cardWrites[0]?.cardId).toBe(cardA);
      expect(Object.keys(state.cardWrites[0]!.payload)).toEqual(["description"]);
      expect(state.cardWrites[0]?.payload.description).toContain(draft);
      expect(state.cards.get(cardB)).toEqual(originalCards[1]);
      expect(await unloadWarns(page)).toBe(false);
      await observation(page, "after-save-consent");

      await openA(page, width);
      await expect(body(page)).toHaveText(draft);
      const saved = structuredClone(state.cards.get(cardA));
      await body(page).fill(`SYNTHETIC DISCARD AFTER FOOTER CANCEL ${width}`);
      await activate(cancel(page), width);
      await expect(prompt(page)).toBeVisible();
      await expect(body(page)).toHaveText(`SYNTHETIC DISCARD AFTER FOOTER CANCEL ${width}`);
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.discard, exact: true }), width);
      await expect.poll(() => path(page)).toBe(boardPath);
      await expect(editor(page)).toBeHidden();
      await settled(state);
      expect(state.cardWrites).toHaveLength(1);
      expect(state.cards.get(cardA)).toEqual(saved);
      expect(await unloadWarns(page)).toBe(false);
      await observation(page, "after-discard-consent");
    });
  });
}
