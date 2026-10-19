// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { routePath, session, sha } from "./fixtures/session-window-fixture";
import { installNavigationFixture, noteHref, originalNoteTitle, type NavigationFixture } from "./fixtures/uxc-navigation-fixture";

test.skip(process.env.BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE !== "1", "Set BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE=1 for synthetic built-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(60_000);

const sources = [
  "e2e/uxc-navigation-pop.spec.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "src/main.tsx", "src/providers/NavigationGuardProvider.tsx", "src/providers/ReturnNavigationProvider.tsx",
  "src/features/sessions/hooks/use-handoff-drafts.tsx", "src/features/notes/components/NoteEditor.tsx",
  "src/features/notes/components/NoteList.tsx", "src/components/ui/unsaved-changes-prompt.tsx",
];
const inputHashes = () => Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))]));
const states = new Map<Page, { fixture: NavigationFixture; before: ReturnType<typeof inputHashes> }>();
const entry = (page: Page) => page.evaluate(() => ({ key: history.state.key, idx: history.state.idx }));

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.fixture.release();
  await Promise.all(state.fixture.pendingAssets);
  const after = inputHashes();
  const path = info.outputPath("dirty-pop-ledger.json");
  writeFileSync(path, JSON.stringify({
    scope: "Actual compiled AppShell with synthetic HTTP/WebSocket responses; native browser history Back/Forward, no deployed authority or server persistence proof",
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    inputsBefore: state.before, inputsAfter: after, builtAssets: state.fixture.assets,
    requests: state.fixture.requests, sockets: state.fixture.socketLedger, failures: state.fixture.failures,
    unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors,
    noteWrites: state.fixture.noteWrites, status: info.status,
  }, null, 2));
  await info.attach("dirty-pop-ledger", { path, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  if (info.status === info.expectedStatus) {
    expect(state.fixture.unexpected).toEqual([]);
    expect(state.fixture.failures).toEqual([]);
    expect(after).toEqual(state.before);
    expect(state.fixture.assets.some((asset) => asset.path.endsWith(".js") && asset.status === 200)).toBe(true);
  }
  states.delete(page);
});

async function settle(state: NavigationFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

for (const width of [1440, 390]) {
  test.describe(`English ${width} browser POP`, () => {
    test.use({ hasTouch: width === 390 });
    test(`${width}: dirty Back keeps edits, failed Save stays blocked, successful Save completes exact POP and Discard survives Forward`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const before = inputHashes();
      const state = await installNavigationFixture(page, "en");
      states.set(page, { fixture: state, before });
      await page.goto(routePath);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
      const activate = (control: Locator) => width === 390 ? control.tap() : control.click();
      if (width === 390) await activate(page.getByRole("tab", { name: en.sessions.detail.tabs.details, exact: true }));
      const originURL = page.url();
      const originEntry = await entry(page);
      const relatedNote = page.getByRole("link", { name: originalNoteTitle, exact: true });
      await expect(relatedNote).toHaveAttribute("href", noteHref);
      await activate(relatedNote);
      const editor = page.getByRole("dialog", { name: en.notes.editTitle, exact: true });
      const title = editor.getByRole("textbox", { name: en.cards.titleLabel, exact: true });
      const body = editor.locator('[contenteditable="true"]');
      await expect(title).toHaveValue(originalNoteTitle);
      const noteURL = page.url();
      const noteEntry = await entry(page);
      expect(noteEntry.idx).toBe(originEntry.idx + 1);
      expect(noteEntry.key).not.toBe(originEntry.key);
      const editedTitle = `SYNTHETIC DIRTY POP TITLE ${width}`;
      const editedBody = `SYNTHETIC DIRTY POP BODY ${width}`;
      await title.fill(editedTitle);
      await body.fill(editedBody);
      const prompt = page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });

      // This invokes the browser's real history traversal. A blocked POP is
      // deliberately not awaited as a successful page navigation.
      await page.evaluate(() => history.back());
      await expect(prompt).toBeVisible();
      await expect(page).toHaveURL(noteURL);
      expect(await entry(page)).toEqual(noteEntry);
      await activate(prompt.getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }));
      await expect(prompt).toBeHidden();
      await expect(title).toHaveValue(editedTitle);
      await expect(body).toHaveText(editedBody);
      expect(state.noteWrites).toEqual([]);

      state.noteSaveStatus = 503;
      await page.evaluate(() => history.back());
      await expect(prompt).toBeVisible();
      await activate(prompt.getByRole("button", { name: en.unsavedChanges.save, exact: true }));
      await expect.poll(() => state.noteWrites.length).toBe(1);
      await settle(state);
      await expect(prompt).toBeVisible();
      await expect(page).toHaveURL(noteURL);
      expect(await entry(page)).toEqual(noteEntry);
      await expect(title).toHaveValue(editedTitle);
      await expect(body).toHaveText(editedBody);
      expect(state.note.title).toBe(originalNoteTitle);
      const failedPayload = structuredClone(state.noteWrites[0]!);
      expect(failedPayload.title).toBe(editedTitle);
      expect(failedPayload.content).toContain(editedBody);

      state.noteSaveStatus = 200;
      await activate(prompt.getByRole("button", { name: en.unsavedChanges.save, exact: true }));
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
      await expect(page).toHaveURL(originURL);
      expect(await entry(page)).toEqual(originEntry);
      await expect(prompt).toBeHidden();
      await settle(state);
      expect(state.noteWrites).toHaveLength(2);
      expect(state.noteWrites[1]).toEqual(failedPayload);

      await page.evaluate(() => history.forward());
      await expect(title).toHaveValue(editedTitle);
      await expect(body).toHaveText(editedBody);
      await expect(page).toHaveURL(noteURL);
      expect(await entry(page)).toEqual(noteEntry);
      await title.fill(`SYNTHETIC DISCARD AFTER POP ${width}`);
      await body.fill(`SYNTHETIC DISCARD BODY ${width}`);
      await page.evaluate(() => history.back());
      await expect(prompt).toBeVisible();
      await activate(prompt.getByRole("button", { name: en.unsavedChanges.discard, exact: true }));
      await expect(page).toHaveURL(originURL);
      expect(await entry(page)).toEqual(originEntry);
      await page.evaluate(() => history.forward());
      await expect(title).toHaveValue(editedTitle);
      await expect(body).toHaveText(editedBody);
      await expect(page).toHaveURL(noteURL);
      expect(await entry(page)).toEqual(noteEntry);
      await settle(state);
      expect(state.noteWrites).toHaveLength(2);
      const serialized = await page.evaluate(() => JSON.stringify({ href: location.href, state: history.state, local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(serialized).not.toContain(editedTitle);
      expect(serialized).not.toContain(editedBody);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  });
}
