// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import { boardPath, cardA, cardHref, cardNames, installCardNavigationFixture, type CardNavigationFixture } from "./fixtures/uxc-card-navigation-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const diagram = "graph TD\n  A[Start] --> B[Finish]";
const description = JSON.stringify({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: diagram }] }, { type: "paragraph" }] });
const inputFiles = ["e2e/uxc-mermaid-escape-review.spec.ts", "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const productionFiles = ["src/extensions/MermaidCodeBlockView.tsx", "src/extensions/mermaid-code-block.ts", "src/components/shared/RichTextEditorImpl.tsx", "src/features/kanban/components/CardDetailSheet.tsx", "src/hooks/use-focus-trap.ts", "src/components/ui/sheet.tsx", "src/components/ui/dialog.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string>; source_files: Record<string, string> } : null;
const states = new Map<Page, { fixture: CardNavigationFixture; savedBefore: unknown; inputsBefore: ReturnType<typeof hashes>; productionBefore: ReturnType<typeof hashes>; observations: unknown[] }>();
const sheet = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const body = (page: Page) => sheet(page).locator('[contenteditable="true"]');
const source = (page: Page) => sheet(page).locator("[data-mermaid-source]");
const preview = (page: Page) => sheet(page).locator("[data-mermaid-preview]");
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const title = (page: Page) => sheet(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true });
const activate = (locator: Locator, width: number) => width === 390 ? locator.tap() : locator.click();
const route = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const entry = (page: Page) => page.evaluate(() => ({ key: history.state.key, idx: history.state.idx }));
async function frames(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function unloadWarns(page: Page) { return page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }); }
async function observation(page: Page, name: string) {
  const value = {
    name, route: route(page), entry: await entry(page), sheetVisible: await sheet(page).isVisible(), promptVisible: await prompt(page).isVisible(),
    sourceShowing: await source(page).count() ? await source(page).getAttribute("aria-hidden") !== "true" : false,
    previewVisible: await preview(page).isVisible(), sourceText: await source(page).count() ? await source(page).textContent() : null,
    title: await title(page).count() ? await title(page).inputValue() : null, unloadWarns: await unloadWarns(page),
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, contentEditable: document.activeElement?.getAttribute("contenteditable"), insideSheet: !!document.activeElement?.closest('[role="dialog"]'), insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]') })),
  };
  states.get(page)!.observations.push(value);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return value;
}
async function setup(page: Page, width: number) {
  expect(manifest).not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installCardNavigationFixture(page);
  fixture.cards.set(cardA, { ...fixture.cards.get(cardA)!, description });
  const productionBefore = hashes(productionFiles);
  states.set(page, { fixture, savedBefore: structuredClone([...fixture.cards.values()]), inputsBefore: hashes(inputFiles), productionBefore, observations: [] });
  for (const [file, hash] of Object.entries(productionBefore)) expect(hash, `Frozen built source: ${file}`).toBe(manifest!.source_files[file]);
  await page.addInitScript(() => {
    const events: unknown[] = [];
    Object.defineProperty(window, "__mermaidEscapeEvents", { value: events });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const before = { key: event.key, trusted: event.isTrusted, target: target?.tagName, insideSource: !!target?.closest("[data-mermaid-source]"), preventedAtCapture: event.defaultPrevented };
      queueMicrotask(() => events.push({ ...before, preventedAfterDispatch: event.defaultPrevented }));
    }, true);
  });
  await page.goto(boardPath);
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => fixture.inflight).toBe(0);
  await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
  await expect(sheet(page)).toBeVisible();
  await expect(preview(page).locator("svg")).toBeVisible();
  await expect(source(page)).toHaveAttribute("aria-hidden", "true");
  await expect(source(page)).toHaveText(diagram);
  await expect(sheet(page).getByRole("button", { name: en.common.save, exact: true })).toBeDisabled();
  expect(await unloadWarns(page)).toBe(false);
  return fixture;
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA(); state.fixture.release();
  await observation(page, "final-state");
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const inputsAfter = hashes(inputFiles), productionAfter = hashes(productionFiles);
  const ledger = info.outputPath("mermaid-escape-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Real frozen AppShell/CardDetailSheet/TipTap/Mermaid node view; synthetic authorized network fixtures; no backend persistence claim",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), head: manifest?.head, tree: manifest?.tree,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), actualTouchPoints: await page.evaluate(() => navigator.maxTouchPoints), reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter, assets,
    observations: state.observations, escapeEvents: await page.evaluate(() => (window as unknown as { __mermaidEscapeEvents?: unknown[] }).__mermaidEscapeEvents ?? []),
    requests: state.fixture.requests, writes: state.fixture.cardWrites, savedBefore: state.savedBefore, savedAfter: [...state.fixture.cards.values()],
    unexpected: state.fixture.unexpected, failures: state.fixture.failures, consoleErrors: state.fixture.consoleErrors, status: info.status,
  }, null, 2));
  await info.attach("mermaid-escape-ledger", { path: ledger, contentType: "application/json" });
  expect.soft(inputsAfter).toEqual(state.inputsBefore); expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(state.fixture.unexpected).toEqual([]); expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.fixture.cardWrites).toEqual([]); expect.soft([...state.fixture.cards.values()]).toEqual(state.savedBefore);
  states.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`${width} nested Mermaid Escape`, () => {
    test.use({ hasTouch: width === 390 });
    for (const dirty of [false, true]) {
      test(`${dirty ? "dirty" : "clean"} host consumes Mermaid Escape before the host close action`, async ({ page }) => {
        await setup(page, width);
        const expectedTitle = dirty ? `Exact unsaved Mermaid host ${width}` : cardNames[cardA];
        if (dirty) {
          await title(page).fill(expectedTitle);
          await expect(sheet(page).getByRole("button", { name: en.common.save, exact: true })).toBeEnabled();
          expect(await unloadWarns(page)).toBe(true);
        }
        await activate(sheet(page).getByRole("button", { name: en.editor.mermaidEdit, exact: true }), width);
        await expect(source(page)).not.toHaveAttribute("aria-hidden", "true");
        await expect(preview(page)).toHaveCount(0);
        await activate(source(page).locator("code"), width);
        await expect(body(page)).toBeFocused();
        expect(await unloadWarns(page), "Clean versus dirty host must be established immediately before Escape").toBe(dirty);
        if (!dirty) await expect(sheet(page).getByRole("button", { name: en.common.save, exact: true })).toBeDisabled();
        expect(await page.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest("[data-mermaid-source]")), "The caret is inside the actual Mermaid source node").toBe(true);
        const origin = await entry(page);
        await observation(page, "source-editing-before-first-escape");
        await page.keyboard.press("Escape");
        await frames(page);
        const first = await observation(page, "first-escape");
        expect.soft(first.sheetVisible, "First Escape exits Mermaid source editing without closing its host").toBe(true);
        expect.soft(first.promptVisible, "First Escape is consumed by Mermaid rather than opening host consent").toBe(false);
        expect.soft(first.sourceShowing).toBe(false);
        expect.soft(first.previewVisible).toBe(true);
        expect.soft(first.sourceText).toBe(diagram);
        expect.soft(first.title).toBe(expectedTitle);
        expect.soft(first.route).toBe(cardHref(cardA));
        expect.soft(first.entry).toEqual(origin);
        expect.soft(first.unloadWarns).toBe(dirty);
        expect.soft(first.focus.contentEditable, "Dismissal returns usable focus to the real editor").toBe("true");
        await page.keyboard.press("Escape");
        await frames(page);
        const second = await observation(page, "second-escape");
        if (dirty) {
          expect.soft(second.sheetVisible).toBe(true);
          expect.soft(second.promptVisible, "Only the second Escape requests host Save/Discard/Keep editing").toBe(true);
          expect.soft(second.route).toBe(cardHref(cardA));
          expect.soft(second.title).toBe(expectedTitle);
          expect.soft(second.sourceText).toBe(diagram);
          expect.soft(second.unloadWarns).toBe(true);
          expect.soft(second.focus.insidePrompt).toBe(true);
        } else {
          expect.soft(second.sheetVisible).toBe(false);
          expect.soft(second.promptVisible).toBe(false);
          expect.soft(second.route).toBe(boardPath);
          expect.soft(second.unloadWarns).toBe(false);
        }
      });
    }
  });
}
