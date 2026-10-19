// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import {
  boardPath, canonicalDescription, cardA, cardB, cardHref, cardNames, installFinalSeamsFixture,
  originalCards, remoteDescription, reviewedText, submittedDescription, targetColumn, targetColumnName,
  type FinalSeamsFixture,
} from "./fixtures/uxc-card-final-seams-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const inputFiles = [
  "e2e/uxc-card-final-seams-review.spec.ts", "e2e/fixtures/uxc-card-final-seams-review.ts",
  "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts",
  "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json",
];
const productionFiles = [
  "src/features/kanban/components/CardDetailSheet.tsx", "src/features/kanban/components/BoardView.tsx",
  "src/features/kanban/api/use-cards.ts", "src/features/kanban/hooks/use-optimistic-card-move.ts",
  "src/providers/NavigationGuardProvider.tsx", "src/components/ui/sheet.tsx", "src/components/ui/dialog.tsx",
];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; files: Record<string, string>; source_files: Record<string, string> } : null;
const states = new Map<Page, { fixture: FinalSeamsFixture; inputsBefore: ReturnType<typeof hashes>; productionBefore: ReturnType<typeof hashes>; observations: unknown[] }>();

const editor = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const body = (page: Page) => editor(page).locator('[contenteditable="true"]');
const title = (page: Page) => editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true, includeHidden: true });
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const footerSave = (page: Page) => editor(page).getByRole("button", { name: en.common.save, exact: true });
const footerCancel = (page: Page) => editor(page).getByRole("button", { name: en.common.cancel, exact: true });
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();
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
  const result = {
    name, url: page.url(), history: await entry(page), editorVisible: await editor(page).isVisible(),
    title: await title(page).count() ? await title(page).inputValue() : null,
    description: await body(page).count() ? await body(page).textContent() : null,
    promptCount: await prompt(page).count(), unloadWarns: await unloadWarns(page),
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.slice(0, 120), insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]'), insideEditor: !!document.activeElement?.closest('[role="dialog"][aria-label]') })),
    writes: structuredClone(state.fixture.cardWrites), moves: structuredClone(state.fixture.moves),
    savedCards: [...state.fixture.cards.values()].map((card) => structuredClone(card)),
  };
  state.observations.push(result);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return result;
}
async function settled(state: FinalSeamsFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}
async function setup(page: Page, width: number) {
  expect(manifest, "Requires supplied frozen built-asset manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const state = await installFinalSeamsFixture(page);
  states.set(page, { fixture: state, inputsBefore: hashes(inputFiles), productionBefore: hashes(productionFiles), observations: [] });
  await page.goto(boardPath);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await settled(state);
  await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
  await expect.poll(() => path(page)).toBe(cardHref(cardA));
  await expect(editor(page)).toBeVisible();
  await expect(title(page)).toHaveValue(cardNames[cardA]);
  await expect(body(page)).toBeVisible();
  await expect(footerSave(page)).toBeDisabled();
  expect(await unloadWarns(page)).toBe(false);
  return state;
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA();
  state.fixture.release();
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const inputsAfter = hashes(inputFiles), productionAfter = hashes(productionFiles);
  const ledger = info.outputPath("final-seams-ledger.json");
  const expectedHttpErrors = state.fixture.moves.filter((move) => move.status === 409).length;
  const consoleWithoutExpected409 = state.fixture.consoleErrors.filter((message) => !(expectedHttpErrors > 0 && message === "Failed to load resource: the server responded with a status of 409 (Conflict)"));
  writeFileSync(ledger, JSON.stringify({
    scope: "Actual preserved built AppShell/BoardView/RichTextEditor; synthetic HTTP/WebSocket; backend canonical fixture from source validator, not live backend persistence",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), builtSource: manifest?.head,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), actualTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    reducedMotion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter,
    builtAssets: assets, observations: state.observations, requests: state.fixture.requests, sockets: state.fixture.socketLedger,
    failures: state.fixture.failures, unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors, expectedHttpErrors,
    writes: state.fixture.cardWrites, moves: state.fixture.moves, remoteEdits: state.fixture.remoteEdits,
    savedCards: [...state.fixture.cards.values()], descriptionResponse: state.fixture.descriptionResponse, status: info.status,
  }, null, 2));
  await info.attach("final-seams-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  expect.soft(state.fixture.unexpected).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(consoleWithoutExpected409).toEqual([]);
  expect.soft(inputsAfter).toEqual(state.inputsBefore);
  expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const width of [1440, 390]) {
  test.describe(`${width} final integration seams`, () => {
    test.use({ hasTouch: width === 390 });

    for (const response of ["canonical", "echo"] as const) {
      test(`partial PATCH success and rejected move preserves a later remote description on retry (${response})`, async ({ page }) => {
        const state = await setup(page, width);
        state.descriptionResponse = response;
        await body(page).fill(reviewedText);
        const columnControl = editor(page).getByRole("button", { name: en.cards.columnLabel, exact: true });
        await columnControl.scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await activate(columnControl, width);
        await activate(page.getByRole("option", { name: targetColumnName, exact: true }), width);
        await activate(footerSave(page), width);
        await expect.poll(() => state.cardWrites[0]?.status).toBe(200);
        await expect.poll(() => state.moves[0]?.status).toBe(409);
        await expect(footerSave(page)).toBeEnabled();
        await settled(state);
        expect(state.cardWrites).toHaveLength(1);
        expect(state.cardWrites[0]!.payload).toEqual({ description: submittedDescription });
        expect(state.cards.get(cardA)?.description).toBe(response === "canonical" ? canonicalDescription : submittedDescription);
        await expect(body(page)).toHaveText(reviewedText);
        expect(path(page)).toBe(cardHref(cardA));
        expect(await unloadWarns(page)).toBe(true);
        await observation(page, "partial-save-before-remote-edit");
        state.applyRemoteDescription();
        state.moveStatus = 200;
        await activate(footerSave(page), width);
        await expect.poll(() => state.moves[1]?.status).toBe(200);
        await expect(editor(page)).toBeHidden();
        await settled(state);
        await observation(page, "after-move-retry");
        expect.soft(state.cardWrites, "Committed description must not be replayed").toHaveLength(1);
        expect.soft(state.cards.get(cardA)?.description, "The later remote write must survive").toBe(remoteDescription);
        expect(state.cards.get(cardA)?.column_id).toBe(targetColumn);
        expect(state.cards.get(cardB)).toEqual(originalCards[1]);
        expect(path(page)).toBe(boardPath);
        expect(await unloadWarns(page)).toBe(false);
      });
    }

    for (const saveEntry of ["footer", "modal"] as const) {
      test(`editable later title stays available after pending ${saveEntry} Save succeeds`, async ({ page }) => {
        const state = await setup(page, width);
        const submitted = `Submitted title ${saveEntry} ${width}`;
        const later = `Unsubmitted later title ${saveEntry} ${width}`;
        await title(page).fill(submitted);
        state.holdA = true;
        if (saveEntry === "modal") {
          await activate(editor(page).getByRole("button", { name: en.common.close, exact: true }), width);
          await expect(prompt(page)).toBeVisible();
          await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.save, exact: true }), width);
          await expect(prompt(page)).toBeHidden();
        } else await activate(footerSave(page), width);
        await expect.poll(() => state.heldA.length).toBe(1);
        expect(state.cardWrites[0]!.payload).toEqual({ title: submitted });
        await expect(title(page)).toBeEditable();
        await title(page).fill(later);
        await expect(title(page)).toHaveValue(later);
        expect(await unloadWarns(page)).toBe(true);
        await observation(page, "later-draft-while-save-pending");
        state.releaseA();
        await expect.poll(() => state.cardWrites[0]?.status).toBe(200);
        await settled(state);
        await expect(editor(page).getByRole("button", { name: en.common.saving, exact: true })).toBeHidden();
        // The visible editor is the recovery boundary. Wait for its committed
        // state before reading the draft, so a transition cannot create a pass.
        await expect.soft(editor(page)).toBeVisible();
        const after = await observation(page, "after-pending-save-response");
        expect.soft(after.title).toBe(later);
        expect.soft(after.unloadWarns).toBe(true);
        expect.soft(path(page)).toBe(cardHref(cardA));
        expect(state.cardWrites).toHaveLength(1);
        expect(state.cards.get(cardA)?.title).toBe(submitted);
        expect(state.cards.get(cardB)).toEqual(originalCards[1]);
      });
    }

    test("Escape dismisses route consent once and restores the original dirty editor", async ({ page }) => {
      const state = await setup(page, width);
      const draft = `Escape must preserve this title ${width}`;
      await title(page).fill(draft);
      const origin = await entry(page);
      await activate(footerCancel(page), width);
      await expect(prompt(page)).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await expect(prompt(page)).toBeHidden();
      await expect(title(page)).toHaveValue(draft);
      await expect(footerCancel(page)).toBeFocused();
      expect(await unloadWarns(page)).toBe(true);
      expect(state.cardWrites).toEqual([]);
      await observation(page, "keep-editing-positive-control");
      await activate(footerCancel(page), width);
      await expect(prompt(page)).toBeVisible();
      await expect(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect.soft(prompt(page)).toBeHidden();
      await observation(page, "after-escape-route-consent");
      await expect(editor(page)).toBeVisible();
      await expect(title(page)).toHaveValue(draft);
      expect(path(page)).toBe(cardHref(cardA));
      expect(await entry(page)).toEqual(origin);
      expect(await unloadWarns(page)).toBe(true);
      expect(state.cardWrites).toEqual([]);
      await expect.soft(footerCancel(page)).toBeFocused();
    });
  });
}


for (const width of [1440, 390]) {
  test.describe(`${width} pending original value`, () => {
    test.use({ hasTouch: width === 390 });

    for (const saveEntry of ["footer", "modal"] as const) {
      for (const field of ["title", "description"] as const) {
        test(`F1 pending undo-to-original ${field} via ${saveEntry} Save`, async ({ page }) => {
          const state = await setup(page, width);
          // This isolates pending-edit reconciliation from serialization. The
          // original canonical-response scenarios above remain unchanged.
          state.descriptionResponse = "echo";
          const control = field === "title" ? title(page) : body(page);
          const originalValue = state.cards.get(cardA)![field];
          const originalText = field === "title" ? originalValue : await body(page).innerText();
          const submittedText = field === "title" ? `Submitted before undo ${saveEntry} ${width}` : reviewedText;
          const submittedValue = field === "title" ? submittedText : submittedDescription;
          const originEntry = await entry(page);
          await control.fill(submittedText);
          state.holdA = true;
          if (saveEntry === "modal") {
            await activate(editor(page).getByRole("button", { name: en.common.close, exact: true }), width);
            await expect(prompt(page)).toBeVisible();
            await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.save, exact: true }), width);
            await expect(prompt(page)).toBeHidden();
          } else await activate(footerSave(page), width);
          await expect.poll(() => state.heldA.length).toBe(1);
          expect(state.cardWrites).toHaveLength(1);
          expect(state.cardWrites[0]!.payload).toEqual({ [field]: submittedValue });
          expect(state.cards.get(cardA)![field]).toBe(originalValue);
          await expect(control).toBeEditable();
          await control.fill(originalText);
          if (field === "title") await expect(control).toHaveValue(originalText);
          else await expect(control).toHaveText(originalText);
          await observation(page, "f1-original-draft-while-save-pending");

          state.releaseA();
          await expect.poll(() => state.cardWrites[0]?.status).toBe(200);
          await settled(state);
          await expect(editor(page).getByRole("button", { name: en.common.saving, exact: true })).toBeHidden();
          await expect(editor(page)).toBeVisible();
          const after = await observation(page, "f1-original-draft-after-response");
          expect(state.cardWrites).toHaveLength(1);
          expect(state.cardWrites[0]!.payload).toEqual({ [field]: submittedValue });
          expect(state.cards.get(cardA)![field]).toBe(submittedValue);
          expect(state.cards.get(cardB)).toEqual(originalCards[1]);
          expect(state.moves).toEqual([]);
          expect(path(page)).toBe(cardHref(cardA));
          expect(await entry(page)).toEqual(originEntry);
          expect.soft(after[field], "The later undo must survive the earlier acknowledgement").toBe(originalText);
          expect.soft(after.unloadWarns, "The later undo is unsaved relative to the acknowledged value").toBe(true);
          await expect(footerSave(page)).toBeEnabled();

          // A second write requires this explicit action after the first has
          // settled; retaining the draft must never silently publish it.
          await activate(footerSave(page), width);
          await expect.poll(() => state.cardWrites[1]?.status).toBe(200);
          await expect(editor(page)).toBeHidden();
          await settled(state);
          expect(state.cardWrites.map((write) => write.payload)).toEqual([
            { [field]: submittedValue }, { [field]: originalValue },
          ]);
          expect(state.cards.get(cardA)![field]).toBe(originalValue);
          expect(state.cards.get(cardB)).toEqual(originalCards[1]);
          expect(state.moves).toEqual([]);
          expect(path(page)).toBe(boardPath);
          expect(await unloadWarns(page)).toBe(false);
          await observation(page, "f1-explicit-second-save-complete");
        });
      }
    }
  });
}
