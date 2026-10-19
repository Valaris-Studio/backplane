// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import {
  boardPath, cardA, cardB, cardHref, cardNames, installFinalSeamsFixture,
  originalCards, type FinalSeamsFixture,
} from "./fixtures/uxc-card-final-seams-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

type Field = "title" | "description";
type Timing = "held-response-control" | "save-completion-commit";
type Probe = {
  events: unknown[];
  injection: null | Record<string, unknown>;
  inject: () => void;
  disconnect: () => void;
};
const inputFiles = [
  "e2e/uxc-save-completion-race-review.spec.ts", "e2e/fixtures/uxc-card-final-seams-review.ts",
  "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts",
  "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json",
];
const productionFiles = [
  "src/features/kanban/components/CardDetailSheet.tsx", "src/features/kanban/components/BoardView.tsx",
  "src/features/kanban/api/use-cards.ts", "src/features/kanban/api/use-card-detail.ts",
  "src/components/shared/RichTextEditorImpl.tsx", "src/hooks/useUnsavedChangesGuard.ts",
  "src/providers/NavigationGuardProvider.tsx",
];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string>; source_files: Record<string, string> } : null;
const states = new Map<Page, { fixture: FinalSeamsFixture; inputsBefore: ReturnType<typeof hashes>; productionBefore: ReturnType<typeof hashes>; observations: unknown[] }>();
const editor = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const fieldControl = (page: Page, field: Field) => field === "title"
  ? editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true })
  : editor(page).locator('[contenteditable="true"]');
const save = (page: Page) => editor(page).getByRole("button", { name: en.common.save, exact: true });
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const route = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const doc = (value: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function unloadWarns(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function observation(page: Page, name: string) {
  const item = {
    name, route: route(page), editorVisible: await editor(page).isVisible(), promptVisible: await prompt(page).isVisible(),
    title: await fieldControl(page, "title").count() ? await fieldControl(page, "title").inputValue() : null,
    description: await fieldControl(page, "description").count() ? await fieldControl(page, "description").textContent() : null,
    saveEnabled: await save(page).count() ? await save(page).isEnabled() : null, unloadWarns: await unloadWarns(page),
    probe: await page.evaluate(() => {
      const probe = (window as unknown as { __completionProbe?: Probe }).__completionProbe;
      return probe ? { events: probe.events, injection: probe.injection } : null;
    }),
    writes: structuredClone(states.get(page)!.fixture.cardWrites),
  };
  states.get(page)!.observations.push(item);
  return item;
}

async function armNativeInput(page: Page, field: Field, timing: Timing, suffix: string) {
  await fieldControl(page, field).evaluate((element, { timing, suffix, savingLabel, saveLabel }) => {
    const control = element as HTMLElement;
    const sheet = control.closest('[role="dialog"]')!;
    if (document.activeElement !== control) throw new Error("Native input requires the actual focused card field");
    const button = Array.from(sheet.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.trim() === savingLabel);
    if (!button) throw new Error("The held save must expose its real Saving button before arming");
    const value = () => control instanceof HTMLInputElement ? control.value : control.textContent;
    let observer: MutationObserver | null = null;
    const probe: Probe = {
      events: [], injection: null,
      inject() {
        if (probe.injection) throw new Error("Native input is injected exactly once");
        const before = value();
        const label = button.textContent?.trim();
        // Native browser editing emits the real input/ProseMirror path without
        // replacing React state, effects, scheduler, editor or DOM contents.
        const returned = document.execCommand("insertText", false, suffix);
        probe.injection = { timing, before, after: value(), returned, buttonLabel: label, fieldFocused: document.activeElement === control, at: performance.now() };
      },
      disconnect() { observer?.disconnect(); },
    };
    for (const eventName of ["beforeinput", "input"]) control.addEventListener(eventName, (event) => {
      const input = event as InputEvent;
      probe.events.push({ type: event.type, trusted: event.isTrusted, inputType: input.inputType, data: input.data, value: value(), buttonLabel: button.textContent?.trim(), at: performance.now() });
    });
    (window as unknown as { __completionProbe: Probe }).__completionProbe = probe;
    if (timing === "save-completion-commit") {
      observer = new MutationObserver((records) => {
        probe.events.push({ type: "mutation-observer", label: button.textContent?.trim(), records: records.map((record) => record.type), connected: control.isConnected, at: performance.now() });
        if (button.textContent?.trim() !== saveLabel) return;
        observer!.disconnect();
        probe.inject();
      });
      observer.observe(button, { childList: true, characterData: true, subtree: true });
    }
  }, { timing, suffix, savingLabel: en.common.saving, saveLabel: en.common.save });
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.releaseA();
  state.fixture.release();
  await observation(page, "final-state");
  await page.evaluate(() => (window as unknown as { __completionProbe?: Probe }).__completionProbe?.disconnect());
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const inputsAfter = hashes(inputFiles), productionAfter = hashes(productionFiles);
  const path = info.outputPath("completion-race-ledger.json");
  writeFileSync(path, JSON.stringify({
    scope: "Native input at actual built AppShell save-completion commit; synthetic authorized HTTP/WebSocket fixtures; no backend persistence claim",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), head: manifest?.head, tree: manifest?.tree,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), status: info.status,
    inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter,
    assets, observations: state.observations, writes: state.fixture.cardWrites, savedCards: [...state.fixture.cards.values()],
    requests: state.fixture.requests, unexpected: state.fixture.unexpected, failures: state.fixture.failures, consoleErrors: state.fixture.consoleErrors,
  }, null, 2));
  await info.attach("completion-race-ledger", { path, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  expect.soft(inputsAfter).toEqual(state.inputsBefore);
  expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(state.fixture.unexpected).toEqual([]);
  expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const field of ["title", "description"] as const) {
  for (const timing of ["held-response-control", "save-completion-commit"] as const) {
    test(`${field}: native input during ${timing} survives and requires explicit save`, async ({ page }) => {
      expect(manifest).not.toBeNull();
      const fixture = await installFinalSeamsFixture(page);
      fixture.descriptionResponse = "echo";
      const productionBefore = hashes(productionFiles);
      states.set(page, { fixture, inputsBefore: hashes(inputFiles), productionBefore, observations: [] });
      for (const [path, hash] of Object.entries(productionBefore)) expect(hash, `Frozen built source: ${path}`).toBe(manifest!.source_files[path]);
      await page.goto(boardPath);
      await expect(page.getByRole("main")).toBeVisible();
      await expect.poll(() => fixture.inflight).toBe(0);
      await page.getByRole("main").getByText(cardNames[cardA], { exact: true }).click();
      await expect(editor(page)).toBeVisible();
      await expect(fieldControl(page, "description")).toHaveText("Saved browser description A");
      await expect(save(page)).toBeDisabled();
      const control = fieldControl(page, field);
      const submittedText = `Submitted ${field} at completion`;
      const suffix = " Z";
      const laterText = submittedText + suffix;
      const submittedValue = field === "title" ? submittedText : doc(submittedText);
      const laterValue = field === "title" ? laterText : doc(laterText);
      await control.fill(submittedText);
      await expect(save(page)).toBeEnabled();
      fixture.holdA = true;
      await save(page).click();
      await expect.poll(() => fixture.heldA.length).toBe(1);
      expect(fixture.cardWrites.map((write) => write.payload)).toEqual([{ [field]: submittedValue }]);
      // The first save cannot auto-close: input occurred while it was pending.
      // Returning to the submitted value leaves no unrelated dirty-field shield.
      await control.fill("Temporary held edit");
      await control.fill(submittedText);
      await expect(control).toBeFocused();
      await frames(page);
      await observation(page, "held-response-before-injection");
      await armNativeInput(page, field, timing, suffix);
      if (timing === "held-response-control") {
        await page.evaluate(() => (window as unknown as { __completionProbe: Probe }).__completionProbe.inject());
        await frames(page);
      }
      fixture.releaseA();
      await expect.poll(() => fixture.cardWrites[0]?.status).toBe(200);
      await expect.poll(() => fixture.inflight).toBe(0);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __completionProbe?: Probe }).__completionProbe?.injection !== null)).toBe(true);
      await frames(page);
      const after = await observation(page, "after-save-completion");
      expect(after.probe!.injection).toMatchObject({ timing, before: submittedText, after: laterText, returned: true, fieldFocused: true, buttonLabel: timing === "held-response-control" ? en.common.saving : en.common.save });
      expect((after.probe!.events as { type: string }[]).some((event) => event.type === "input")).toBe(true);
      expect(fixture.cards.get(cardA)![field]).toBe(submittedValue);
      expect(fixture.cardWrites).toHaveLength(1);
      expect.soft(after[field], "The native completion-boundary edit remains visible").toBe(laterText);
      expect.soft(after.unloadWarns, "The later edit must remain guarded").toBe(true);
      expect.soft(after.saveEnabled, "Explicit follow-up save must remain available").toBe(true);
      expect(route(page)).toBe(cardHref(cardA));
      await editor(page).getByRole("button", { name: en.common.close, exact: true }).click();
      await frames(page);
      const closing = await observation(page, "close-intent-after-later-edit");
      expect(closing.promptVisible, "Closing must request Save/Discard/Cancel for the later edit").toBe(true);
      expect(closing.editorVisible).toBe(true);
      await prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }).click();
      await save(page).click();
      await expect.poll(() => fixture.cardWrites[1]?.status).toBe(200);
      await expect(editor(page)).toBeHidden();
      expect(fixture.cardWrites.map((write) => write.payload)).toEqual([{ [field]: submittedValue }, { [field]: laterValue }]);
      expect(fixture.cards.get(cardA)![field]).toBe(laterValue);
      expect(fixture.cards.get(cardB)).toEqual(originalCards[1]);
      expect(fixture.moves).toEqual([]);
      expect(route(page)).toBe(boardPath);
      expect(await unloadWarns(page)).toBe(false);
      await observation(page, "explicit-follow-up-save-complete");
    });
  }
}
