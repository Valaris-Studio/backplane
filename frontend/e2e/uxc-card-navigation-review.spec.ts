// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import { boardId, boardPath, cardA, cardB, cardHref, cardNames, installCardNavigationFixture, originalCards, type CardNavigationFixture } from "./fixtures/uxc-card-navigation-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Set BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE=1 for synthetic built-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const fixtureFiles = ["e2e/uxc-card-navigation-review.spec.ts", "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const observedProduction = ["src/features/kanban/components/BoardView.tsx", "src/features/kanban/components/CardDetailSheet.tsx", "src/providers/NavigationGuardProvider.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head?: string; files: Record<string, string> } : null;
type Observation = { name: string; url: string; title: string | null; body: string | null; focus: unknown; unloadWarns: boolean; writes: unknown };
const states = new Map<Page, { fixture: CardNavigationFixture; before: ReturnType<typeof hashes>; observations: Observation[] }>();

function editor(page: Page) { return page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true }); }
function body(page: Page) { return editor(page).locator('[contenteditable="true"]'); }
function prompt(page: Page) { return page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true }); }
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

async function observe(page: Page, name: string) {
  const state = states.get(page)!;
  const title = editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true, includeHidden: true });
  state.observations.push({ name, url: page.url(),
    title: await title.count() ? await title.inputValue() : null,
    body: await body(page).count() ? await body(page).textContent() : null,
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.slice(0, 160), insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]') })),
    unloadWarns: await unloadWarns(page), writes: structuredClone(state.fixture.cardWrites),
  });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function settled(state: CardNavigationFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function loaded(page: Page, id: string) {
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(cardNames[id]!);
  await expect(body(page)).toBeVisible();
  await expect.poll(() => path(page)).toBe(cardHref(id));
}

async function follow(page: Page, id: string, width: number) {
  const link = editor(page).getByRole("link", { name: cardNames[id]!, exact: true });
  await expect(link).toHaveAttribute("href", cardHref(id));
  await activate(link, width);
}

async function setup(page: Page, width: number, firstCard: string) {
  expect(manifest, "Provide the exact preserved dist manifest, never infer source/build equivalence").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installCardNavigationFixture(page);
  states.set(page, { fixture, before: hashes(fixtureFiles), observations: [] });
  await page.goto(boardPath);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await settled(fixture);
  // Exercise actual board controls; board search is in-memory and sorting is
  // persisted collection state, not invented URL filter parameters.
  await activate(page.getByRole("button", { name: en.kanban.filterBar.toggle, exact: true }), width);
  await page.getByRole("searchbox", { name: en.kanban.filterBar.searchPlaceholder, exact: true }).fill("Synthetic card");
  await activate(page.getByRole("button", { name: `${en.collection.sortBy}: ${en.kanban.filterBar.sort.manual}`, exact: true }), width);
  await activate(page.getByRole("menuitem", { name: en.kanban.filterBar.sort.title, exact: true }), width);
  await activate(page.getByRole("main").getByText(cardNames[firstCard]!, { exact: true }), width);
  await loaded(page, firstCard);
  await settled(fixture);
  await expect(editor(page).getByRole("button", { name: en.common.save, exact: true })).toBeDisabled();
  return fixture;
}

async function filtersRetained(page: Page) {
  // The modal marks the board inert; inspect its retained controls directly.
  await expect(page.getByLabel(en.kanban.filterBar.searchPlaceholder, { exact: true })).toHaveValue("Synthetic card");
  const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), `collection-view:kanban:${boardId}`);
  expect(persisted.sortId).toBe("title");
  expect(persisted.sortDirection).toBe("asc");
}

async function nativeReloadWarns(page: Page) {
  const original = page.url();
  const document = await page.evaluateHandle(() => window.document);
  const warning = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  expect(page.url()).toBe(original);
  expect(await document.evaluate((prior) => prior === window.document)).toBe(true);
  await document.dispose();
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA();
  state.fixture.release();
  await Promise.all(state.fixture.pendingAssets);
  const after = hashes(fixtureFiles);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const ledger = info.outputPath("card-navigation-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Actual preserved built AppShell/BoardView/RichTextEditor with synthetic HTTP/WebSocket; not deployed authorization/persistence proof",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), builtSource: manifest?.head,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), hasTouch: info.project.use.hasTouch,
    fixtureInputsBefore: state.before, fixtureInputsAfter: after,
    currentSourceHashesForContextOnly: hashes(observedProduction),
    builtAssets: assets, observations: state.observations,
    requests: state.fixture.requests, sockets: state.fixture.socketLedger,
    failures: state.fixture.failures, unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors,
    cardWrites: state.fixture.cardWrites, savedCards: [...state.fixture.cards.values()], status: info.status,
  }, null, 2));
  await info.attach("card-navigation-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  expect.soft(state.fixture.unexpected).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(after).toEqual(state.before);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`${width} actual card navigation`, () => {
    test.use({ hasTouch: width === 390 });

    test("R1 same-board linked-card Keep editing, Save and Discard preserve the current draft and filters", async ({ page }) => {
      const state = await setup(page, width, cardA);
      // Positive control: real reciprocal dependency links and board controls.
      await follow(page, cardB, width);
      await loaded(page, cardB);
      await follow(page, cardA, width);
      await loaded(page, cardA);
      await filtersRetained(page);
      expect(state.cardWrites).toEqual([]);
      const originEntry = await entry(page);
      const draft = `SYNTHETIC BROWSER DRAFT A ${width}`;
      await body(page).fill(draft);
      await follow(page, cardB, width);
      await expect(prompt(page)).toBeVisible();
      await observe(page, "r1-before-consent");
      expect(path(page)).toBe(cardHref(cardA));
      expect(await entry(page)).toEqual(originEntry);
      expect(state.cardWrites).toEqual([]);
      await expect(body(page)).toHaveText(draft);
      await expect(editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true, includeHidden: true })).toHaveValue(cardNames[cardA]);
      await expect(prompt(page).getByRole("button", { name: en.unsavedChanges.save, exact: true })).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await expect(prompt(page)).toBeHidden();
      await expect(body(page)).toHaveText(draft);
      await nativeReloadWarns(page);
      await follow(page, cardB, width);
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.save, exact: true }), width);
      await loaded(page, cardB);
      await settled(state);
      expect(state.cardWrites).toHaveLength(1);
      expect(state.cardWrites[0]?.cardId).toBe(cardA);
      expect(Object.keys(state.cardWrites[0]!.payload)).toEqual(["description"]);
      expect(state.cardWrites[0]!.payload.description).toContain(draft);
      expect(state.cards.get(cardB)).toEqual(originalCards[1]);
      await follow(page, cardA, width);
      await loaded(page, cardA);
      await body(page).fill(`SYNTHETIC DISCARD A ${width}`);
      await follow(page, cardB, width);
      await expect(prompt(page)).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.discard, exact: true }), width);
      await loaded(page, cardB);
      await settled(state);
      expect(state.cardWrites).toHaveLength(1);
      await filtersRetained(page);
      expect(await unloadWarns(page)).toBe(false);
      await observe(page, "r1-after-decisions");
      expect(state.consoleErrors).toEqual([]);
    });

    for (const outcome of [200, 503] as const) {
      test(`N1 held manual A save ${outcome}, native Back/Discard to B, late settlement preserves B`, async ({ page }) => {
        const state = await setup(page, width, cardB);
        const bEntry = await entry(page);
        await follow(page, cardA, width);
        await loaded(page, cardA);
        const aEntry = await entry(page);
        expect(aEntry.idx).toBe(bEntry.idx + 1);
        state.holdA = true;
        state.outcomeA = outcome;
        const submitted = `SYNTHETIC SUBMITTED A ${width}`;
        await body(page).fill(submitted);
        await activate(editor(page).getByRole("button", { name: en.common.save, exact: true }), width);
        await expect.poll(() => state.cardWrites.length).toBe(1);
        expect(state.cardWrites[0]?.status).toBeUndefined();
        expect(state.cards.get(cardA)).toEqual(originalCards[0]);
        await page.evaluate(() => history.back());
        await expect(prompt(page)).toBeVisible();
        expect(path(page)).toBe(cardHref(cardA));
        expect(await entry(page)).toEqual(aEntry);
        await observe(page, `n1-${outcome}-before-discard`);
        await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.discard, exact: true }), width);
        await loaded(page, cardB);
        expect(await entry(page)).toEqual(bEntry);
        const draftB = `SYNTHETIC PRIVATE DRAFT B ${width} ${outcome}`;
        await body(page).fill(draftB);
        expect(await unloadWarns(page)).toBe(true);
        await nativeReloadWarns(page);
        await observe(page, `n1-${outcome}-before-settlement`);
        state.releaseA();
        await expect.poll(() => state.cardWrites[0]?.status).toBe(outcome);
        await settled(state);
        await observe(page, `n1-${outcome}-after-settlement`);
        expect(path(page)).toBe(cardHref(cardB));
        await expect(editor(page)).toBeVisible();
        await expect(body(page)).toHaveText(draftB);
        await expect(editor(page).getByRole("alert")).toHaveCount(0);
        await expect(editor(page).getByRole("button", { name: en.common.save, exact: true })).toBeEnabled();
        expect(await unloadWarns(page)).toBe(true);
        await filtersRetained(page);
        expect(state.cards.get(cardB)).toEqual(originalCards[1]);
        const publicState = await page.evaluate(() => JSON.stringify({ href: location.href, state: history.state, local: { ...localStorage }, session: { ...sessionStorage } }));
        expect(publicState).not.toContain(draftB);
        await activate(editor(page).getByRole("button", { name: en.common.save, exact: true }), width);
        await settled(state);
        expect(state.cardWrites).toHaveLength(2);
        expect(state.cardWrites[1]?.cardId).toBe(cardB);
        expect(state.cardWrites[1]?.payload.description).toContain(draftB);
        await expect.poll(() => path(page)).toBe(boardPath);
        expect(await unloadWarns(page)).toBe(false);
        expect(state.consoleErrors.filter((message) => outcome !== 503 || !message.includes("503"))).toEqual([]);
      });
    }
  });
}
