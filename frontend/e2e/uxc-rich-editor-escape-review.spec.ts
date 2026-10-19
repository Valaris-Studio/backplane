// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import {
  boardPath, cardA, cardHref, cardNames, installCardNavigationFixture, originalCards,
  type CardNavigationFixture,
} from "./fixtures/uxc-card-navigation-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const inputFiles = [
  "e2e/uxc-rich-editor-escape-review.spec.ts", "e2e/fixtures/uxc-card-navigation-review.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "playwright.config.ts", "src/i18n/locales/en.json",
];
const productionFiles = [
  "src/features/kanban/components/CardDetailSheet.tsx", "src/hooks/use-focus-trap.ts",
  "src/components/ui/sheet.tsx", "src/components/ui/dialog.tsx",
  "src/components/shared/RichTextEditorImpl.tsx", "src/components/shared/editor/use-mention-picker.tsx",
  "src/components/shared/editor/mention-suggestion-plugin.ts", "src/components/shared/editor/MentionPicker.tsx",
  "src/features/mentions/api/use-workspace-member-search.ts", "src/hooks/useUnsavedChangesGuard.ts",
];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; files: Record<string, string>; source_files: Record<string, string>;
} : null;
const states = new Map<Page, {
  fixture: CardNavigationFixture;
  inputsBefore: ReturnType<typeof hashes>;
  productionBefore: ReturnType<typeof hashes>;
  observations: unknown[];
}>();

const editor = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const body = (page: Page) => editor(page).locator('[contenteditable="true"]');
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const picker = (page: Page) => page.getByRole("listbox", { name: en.mentions.listLabel, exact: true });
const footerSave = (page: Page) => editor(page).getByRole("button", { name: en.common.save, exact: true });
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();
const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const entry = (page: Page) => page.evaluate(() => ({ key: history.state.key, idx: history.state.idx }));
const draft = (page: Page) => body(page).evaluate((element) => ({ html: element.innerHTML, text: element.textContent }));

async function unloadWarns(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function observation(page: Page, name: string) {
  const state = states.get(page)!;
  const result = {
    name, url: page.url(), history: await entry(page), editorVisible: await editor(page).isVisible(),
    draft: await body(page).count() ? await draft(page) : null,
    promptVisible: await prompt(page).isVisible(), pickerVisible: await picker(page).isVisible(),
    unloadWarns: await unloadWarns(page),
    focus: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      contentEditable: document.activeElement?.getAttribute("contenteditable"),
      label: document.activeElement?.getAttribute("aria-label"),
      insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]'),
    })),
    writes: structuredClone(state.fixture.cardWrites),
  };
  state.observations.push(result);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return result;
}

async function setup(page: Page, width: number) {
  expect(manifest, "Requires supplied frozen built-asset manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installCardNavigationFixture(page);
  const productionBefore = hashes(productionFiles);
  states.set(page, { fixture, inputsBefore: hashes(inputFiles), productionBefore, observations: [] });
  for (const [sourcePath, digest] of Object.entries(productionBefore)) {
    expect(digest, `Current source matches supplied build: ${sourcePath}`).toBe(manifest!.source_files[sourcePath]);
  }
  // Observe the real DOM event after every handler has run. No handler, editor
  // state, or default behavior is replaced to make the Escape seam observable.
  await page.addInitScript(() => {
    const events: unknown[] = [];
    Object.defineProperty(window, "__richEditorEscapeEvents", { value: events });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const before = {
        key: event.key, keyCode: event.keyCode, isComposing: event.isComposing,
        target: target?.tagName, contentEditable: target?.getAttribute("contenteditable"),
        preventedAtCapture: event.defaultPrevented,
      };
      queueMicrotask(() => events.push({ ...before, preventedAfterDispatch: event.defaultPrevented }));
    }, true);
  });
  await page.goto(boardPath);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => fixture.inflight).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
  await expect.poll(() => path(page)).toBe(cardHref(cardA));
  await expect(editor(page)).toBeVisible();
  await expect(body(page)).toBeVisible();
  await expect(body(page)).toHaveText("Saved browser description A");
  await expect(footerSave(page)).toBeDisabled();
  expect(await unloadWarns(page)).toBe(false);
  await activate(body(page), width);
  await expect(body(page)).toBeFocused();
  return fixture;
}

async function assertGuardPreservesDraft(page: Page, before: Awaited<ReturnType<typeof draft>>, origin: Awaited<ReturnType<typeof entry>>) {
  await expect(prompt(page)).toBeVisible();
  for (const label of [en.unsavedChanges.save, en.unsavedChanges.discard, en.unsavedChanges.keepEditing]) {
    await expect(prompt(page).getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true })).toBeFocused();
  expect(await draft(page)).toEqual(before);
  expect(path(page)).toBe(cardHref(cardA));
  expect(await entry(page)).toEqual(origin);
  expect(await unloadWarns(page)).toBe(true);
  expect(states.get(page)!.fixture.cardWrites).toEqual([]);
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA();
  state.fixture.release();
  await observation(page, "final-state");
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({
    ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null,
  }));
  const inputsAfter = hashes(inputFiles), productionAfter = hashes(productionFiles);
  const ledger = info.outputPath("rich-editor-escape-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Actual frozen built AppShell, CardDetailSheet, RichTextEditor and mention picker; synthetic authorized HTTP/WebSocket fixtures; no backend persistence or native mobile keyboard claim",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), builtSource: manifest?.head,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    actualTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter,
    builtAssets: assets, observations: state.observations, requests: state.fixture.requests, sockets: state.fixture.socketLedger,
    escapeEvents: await page.evaluate(() => (window as unknown as { __richEditorEscapeEvents?: unknown[] }).__richEditorEscapeEvents ?? []),
    failures: state.fixture.failures, unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors,
    writes: state.fixture.cardWrites, savedCards: [...state.fixture.cards.values()], status: info.status,
  }, null, 2));
  await info.attach("rich-editor-escape-ledger", { path: ledger, contentType: "application/json" });
  expect.soft(state.fixture.unexpected).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(inputsAfter).toEqual(state.inputsBefore);
  expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.fixture.cardWrites).toEqual([]);
  expect.soft([...state.fixture.cards.values()]).toEqual(originalCards);
  states.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`${width} real rich editor Escape`, () => {
    test.use({ hasTouch: width === 390 });

    test("clean description Escape closes the card sheet", async ({ page }) => {
      await setup(page, width);
      await observation(page, "clean-editor-focused");
      await page.keyboard.press("Escape");
      await expect(editor(page)).toBeHidden();
      expect(path(page)).toBe(boardPath);
      expect(await unloadWarns(page)).toBe(false);
      await expect(prompt(page)).toBeHidden();
    });

    test("dirty description Escape opens save discard cancel without changing draft or route", async ({ page }) => {
      await setup(page, width);
      await body(page).fill(`Exact unsaved description — ${width}: keep every character.`);
      await expect(footerSave(page)).toBeEnabled();
      await expect(body(page)).toBeFocused();
      const before = await draft(page), origin = await entry(page);
      expect(await unloadWarns(page)).toBe(true);
      await observation(page, "dirty-editor-focused");
      await page.keyboard.press("Escape");
      await assertGuardPreservesDraft(page, before, origin);
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await expect(prompt(page)).toBeHidden();
      await expect(body(page)).toBeFocused();
      expect(await draft(page)).toEqual(before);
    });

    test("mention picker consumes first Escape and the next Escape guards the unchanged draft", async ({ page }) => {
      const fixture = await setup(page, width);
      await body(page).fill(`Mention draft ${width} `);
      await page.keyboard.type("@Syn");
      await expect(picker(page)).toBeVisible();
      await expect(picker(page).getByRole("option", { name: /Synthetic operator/ })).toBeVisible();
      await expect.poll(() => fixture.requests.some((request) => {
        const query = new URLSearchParams(request.query);
        return request.path.endsWith("/members") && query.get("q") === "Syn" && query.get("limit") === "10" && request.status === 200;
      }), "Real mention lookup must complete against the authorized synthetic member route").toBe(true);
      await expect(body(page)).toBeFocused();
      await expect(footerSave(page)).toBeEnabled();
      const before = await draft(page), origin = await entry(page);
      await observation(page, "mention-picker-visible");
      await page.keyboard.press("Escape");
      await expect(picker(page)).toBeHidden();
      await expect(prompt(page)).toBeHidden();
      await expect(editor(page)).toBeVisible();
      await expect(body(page)).toBeFocused();
      expect(await draft(page)).toEqual(before);
      expect(path(page)).toBe(cardHref(cardA));
      expect(await entry(page)).toEqual(origin);
      expect(fixture.cardWrites).toEqual([]);
      await observation(page, "first-escape-consumed-by-mention-picker");
      await page.keyboard.press("Escape");
      await assertGuardPreservesDraft(page, before, origin);
    });
  });
}
