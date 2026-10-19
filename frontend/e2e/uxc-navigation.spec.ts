// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardId, contentId, routePath, session, sessionId, sha, slug, windowRequests } from "./fixtures/session-window-fixture";
import {
  installNavigationFixture, noteHref, originalNoteTitle, privateDraftBody, privateDraftTitle,
  type NavigationFixture,
} from "./fixtures/uxc-navigation-fixture";

test.skip(process.env.BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE !== "1", "Set BACKPLANE_E2E_UXC_NAVIGATION_FIXTURE=1 for synthetic built-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(60_000);

const labelsByLocale = { en, es, "pt-BR": pt };
type Locale = keyof typeof labelsByLocale;
const states = new Map<Page, NavigationFixture>();
const sources = [
  "e2e/uxc-navigation.spec.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "src/main.tsx", "src/providers/NavigationGuardProvider.tsx", "src/providers/ReturnNavigationProvider.tsx",
  "src/components/shared/ContextLink.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/features/sessions/api/use-session-window.ts", "src/features/sessions/components/SessionTranscript.tsx",
  "src/features/sessions/components/SessionDetailPage.tsx", "src/features/sessions/components/ExcerptNoteDialog.tsx",
  "src/features/notes/components/NoteEditor.tsx", "src/features/notes/components/NoteList.tsx",
];
const inputHashes = () => Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))]));
const startingInputs = new Map<Page, ReturnType<typeof inputHashes>>();

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.release();
  await Promise.all(state.pendingAssets);
  const after = inputHashes();
  const receipt = info.outputPath("navigation-ledger.json");
  writeFileSync(receipt, JSON.stringify({
    scope: "Synthetic HTTP/WebSocket responses through actual built AppShell; no deployed authorization or server persistence claim",
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    inputsBefore: startingInputs.get(page), inputsAfter: after, builtAssets: state.assets,
    requests: state.requests, sockets: state.socketLedger, failures: state.failures,
    unexpected: state.unexpected, consoleErrors: state.consoleErrors,
  }, null, 2));
  await info.attach("navigation-ledger", { path: receipt, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  if (info.status === info.expectedStatus) {
    expect(state.unexpected).toEqual([]);
    expect(after).toEqual(startingInputs.get(page));
    expect(state.assets.some((asset) => asset.path.endsWith(".js") && asset.status === 200)).toBe(true);
    expect(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  }
  states.delete(page);
  startingInputs.delete(page);
});

async function setup(page: Page, locale: Locale, width: number, path = noteHref) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  startingInputs.set(page, inputHashes());
  const state = await installNavigationFixture(page, locale);
  states.set(page, state);
  await page.goto(path);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  return state;
}

async function settle(state: NavigationFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

function noteEditor(page: Page, locale: Locale) {
  return page.getByRole("dialog", { name: labelsByLocale[locale].notes.editTitle, exact: true });
}

async function openTranscript(page: Page, locale: Locale) {
  const labels = labelsByLocale[locale].sessions;
  await page.getByRole("tab", { name: labels.contents.title, exact: true }).click();
  const reader = page.getByRole("region", { name: labels.contents.title, exact: true });
  await expect(reader).toBeVisible();
  return reader;
}

async function followSessionLink(page: Page, locale: Locale) {
  const link = noteEditor(page, locale).getByRole("link", { name: session.title!, exact: true });
  await expect(link).toHaveAttribute("href", routePath);
  await link.focus();
  await link.press("Enter");
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
}

async function assertPrivateStateIsMemoryOnly(page: Page) {
  const publicState = await page.evaluate(() => JSON.stringify({
    href: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage },
  }));
  expect(publicState).not.toContain(privateDraftTitle);
  expect(publicState).not.toContain(privateDraftBody);
}

async function assertReloadWarnsAndCancelKeepsPage(page: Page) {
  const originalUrl = page.url();
  const originalDocument = await page.evaluateHandle(() => document);
  const dialogPromise = page.waitForEvent("dialog");
  // A cancelled reload never emits a load event. Observe the real warning and
  // document identity instead of awaiting page.reload() as a completed visit.
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  expect(page.url()).toBe(originalUrl);
  expect(await originalDocument.evaluate((original) => original === document)).toBe(true);
  await originalDocument.dispose();
}

async function makeUnknownHandoff(page: Page, reader: Locator, locale: Locale) {
  const labels = labelsByLocale[locale].sessions.contents.excerpt;
  await reader.getByRole("button", { name: labels.preview, exact: true }).click();
  const preview = page.getByRole("dialog", { name: labels.title, exact: true });
  await expect(preview.getByLabel(labels.previewLabel)).toHaveValue(/SYNTHETIC COMPLETE RECORD/);
  await preview.getByRole("button", { name: labels.note.share, exact: true }).click();
  const draft = page.getByRole("dialog", { name: labels.note.share, exact: true });
  await draft.getByRole("combobox", { name: labels.note.workspace, exact: true }).selectOption(slug);
  await draft.getByRole("combobox", { name: labels.note.board, exact: true }).selectOption(boardId);
  await draft.getByRole("textbox", { name: labels.note.title, exact: true }).fill(privateDraftTitle);
  await draft.getByRole("region", { name: labels.note.content, exact: true }).locator("[contenteditable]").fill(privateDraftBody);
  await expect(draft.getByText(labels.note.memoryOnly, { exact: true })).toBeVisible();
  await draft.getByRole("button", { name: labels.note.save, exact: true }).click();
  await expect(draft.getByRole("alert")).toHaveText(labels.note.unknown);
  await draft.getByRole("button", { name: labels.note.hide, exact: true }).click();
  return labels.note;
}

for (const locale of ["en", "es", "pt-BR"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${locale} ${width} navigation`, () => {
    test.use({ hasTouch: width === 390 });
    test(`${locale} ${width}: A01 R2 keeps Transcript after an anchored Beginning replacement and Back`, async ({ page }) => {
      const state = await setup(page, locale, width, `${routePath}#content-${contentId(152)}`);
      const labels = labelsByLocale[locale];
      const transcriptTab = page.getByRole("tab", { name: labels.sessions.detail.tabs.transcript, exact: true });
      const reader = page.getByRole("region", { name: labels.sessions.contents.title, exact: true });
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await expect(reader).toBeVisible();
      await expect(page.locator(`#content-${contentId(152)}`)).toBeVisible();
      const anchoredKey = await page.evaluate(() => history.state.key);
      await reader.getByRole("button", { name: labels.sessions.contents.window.beginning, exact: true }).click();
      await expect.poll(() => new URL(page.url()).hash).toBe("");
      await expect.poll(() => page.evaluate(() => history.state.key)).not.toBe(anchoredKey);
      const replacedKey = await page.evaluate(() => history.state.key);
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(`#content-${contentId(1)}`)).toBeVisible();
      await expect(page.locator(`#content-${contentId(100)}`)).toBeAttached();
      await settle(state);

      // Do not select Details: that would write the missing tab snapshot and
      // conceal the hash-clearing REPLACE defect before leaving the reader.
      if (width < 1280) {
        await page.getByRole("button", { name: labels.a11y.topbar.toggleSidebar, exact: true }).tap();
        await page.getByRole("link", { name: labels.nav.notes, exact: true }).tap();
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/${slug}/notes`);
        await expect(page.getByText(originalNoteTitle, { exact: true })).toBeVisible();
      } else {
        const relatedNote = page.getByRole("link", { name: originalNoteTitle, exact: true });
        await relatedNote.focus();
        await relatedNote.press("Enter");
        await expect(noteEditor(page, locale)).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toHaveCount(0);
      const returnStart = state.requests.length;
      await page.goBack();
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
      expect(await page.evaluate(() => history.state.key)).toBe(replacedKey);
      expect(new URL(page.url()).hash).toBe("");
      await page.screenshot({ path: test.info().outputPath("r2-after-back.png") });
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await expect(reader).toBeVisible();
      await expect(page.locator(`#content-${contentId(1)}`)).toBeVisible();
      await expect(page.locator(`#content-${contentId(100)}`)).toBeAttached();
      await expect(page.locator(`#content-${contentId(9902)}`)).toHaveCount(0);
      await settle(state);
      expect(windowRequests(state, returnStart).some((request) => request.mode === "refresh" && request.cursor === "window:1:100")).toBe(true);
      expect(state.noteWrites).toEqual([]);
    });

    test(`${locale} ${width}: shared note → earlier reader window → related note → Back retains reviewed handoff`, async ({ page }) => {
      const state = await setup(page, locale, width);
      const labels = labelsByLocale[locale];
      await expect(noteEditor(page, locale).getByRole("textbox", { name: labels.cards.titleLabel, exact: true })).toHaveValue(originalNoteTitle);
      await followSessionLink(page, locale);
      const reader = await openTranscript(page, locale);
      await reader.getByRole("button", { name: labels.sessions.contents.filters.everything, exact: true }).click();
      await reader.getByRole("button", { name: labels.sessions.contents.window.beginning, exact: true }).click();
      await expect(page.locator(`#content-${contentId(1)}`)).toBeVisible();
      await reader.getByRole("button", { name: labels.sessions.contents.window.later, exact: true }).click();
      const selected = page.locator(`#content-${contentId(152)}`);
      await expect(selected).toBeAttached();
      await reader.getByRole("combobox", { name: labels.sessions.contents.navigation.label, exact: true }).selectOption(contentId(152));
      await expect(selected).toBeFocused();
      await selected.locator("label").click();
      await expect(selected.getByRole("checkbox")).toBeChecked();
      const handoff = await makeUnknownHandoff(page, reader, locale);
      await settle(state);
      const firstSave = state.requests.find((request) => request.method === "POST" && request.path.endsWith("/notes/from-excerpt"))!;
      expect(JSON.parse(firstSave.payload!).excerpt_source.items).toHaveLength(1);
      await assertPrivateStateIsMemoryOnly(page);
      await assertReloadWarnsAndCancelKeepsPage(page);
      await expect(reader.getByRole("button", { name: handoff.resume, exact: true })).toBeVisible();

      if (width < 1280) await page.getByRole("tab", { name: labels.sessions.detail.tabs.details, exact: true }).click();
      const relatedNote = page.getByRole("link", { name: originalNoteTitle, exact: true });
      await expect(relatedNote).toHaveAttribute("href", noteHref);
      const sharedHref = await relatedNote.getAttribute("href");
      expect(sharedHref).not.toContain(sessionId);
      expect(sharedHref).not.toContain("content-");
      await relatedNote.focus();
      const departureTop = await relatedNote.evaluate((element) => element.getBoundingClientRect().top);
      if (width === 390) await relatedNote.tap();
      else await relatedNote.press("Enter");
      await expect(noteEditor(page, locale)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${noteHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      await assertPrivateStateIsMemoryOnly(page);
      const returnStart = state.requests.length;
      await page.goBack();
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
      if (width < 1280) await expect(page.getByRole("tab", { name: labels.sessions.detail.tabs.details, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(relatedNote).toBeFocused();
      expect(Math.abs((await relatedNote.evaluate((element) => element.getBoundingClientRect().top)) - departureTop)).toBeLessThanOrEqual(8);
      const returnedReader = await openTranscript(page, locale);
      await expect(returnedReader.getByRole("button", { name: labels.sessions.contents.filters.everything, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(`#content-${contentId(101)}`)).toBeAttached();
      await expect(page.locator(`#content-${contentId(200)}`)).toBeAttached();
      await expect(page.locator(`#content-${contentId(9902)}`)).toHaveCount(0);
      await expect(selected.getByRole("checkbox")).toBeChecked();
      await settle(state);
      expect(windowRequests(state, returnStart).some((request) => request.mode === "refresh" && request.cursor === "window:101:200")).toBe(true);
      await returnedReader.getByRole("button", { name: handoff.resume, exact: true }).click();
      const resumed = page.getByRole("dialog", { name: handoff.share, exact: true });
      await expect(resumed.getByRole("textbox", { name: handoff.title, exact: true })).toHaveValue(privateDraftTitle);
      await expect(resumed.getByRole("region", { name: handoff.content, exact: true })).toContainText(privateDraftBody);
      await expect(resumed.getByRole("combobox", { name: handoff.board, exact: true })).toHaveValue(boardId);
      await resumed.getByRole("button", { name: handoff.retry, exact: true }).click();
      await expect(resumed.getByRole("alert")).toHaveText(handoff.unknown);
      await settle(state);
      const saves = state.requests.filter((request) => request.method === "POST" && request.path.endsWith("/notes/from-excerpt"));
      expect(saves).toHaveLength(2);
      expect(saves[1].payload).toBe(firstSave.payload);
      await page.screenshot({ path: test.info().outputPath("restored-handoff.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
    });
  }

  test.describe(`${locale} narrow note guard`, () => {
  test.use({ hasTouch: true });
  test(`${locale}: dirty note Cancel, failed Save, successful Save and Discard follow actual route decisions`, async ({ page }) => {
    const state = await setup(page, locale, 390);
    const labels = labelsByLocale[locale];
    const editor = noteEditor(page, locale);
    const title = editor.getByRole("textbox", { name: labels.cards.titleLabel, exact: true });
    await expect(title).toHaveValue(originalNoteTitle);
    const editedTitle = "SYNTHETIC NOTE EDIT THAT MUST SURVIVE FAILURE";
    await title.fill(editedTitle);
    await assertReloadWarnsAndCancelKeepsPage(page);
    await expect(title).toHaveValue(editedTitle);
    const link = editor.getByRole("link", { name: session.title!, exact: true });
    const prompt = page.getByRole("alertdialog", { name: labels.unsavedChanges.title, exact: true });
    await link.click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: labels.unsavedChanges.keepEditing, exact: true }).click();
    await expect(title).toHaveValue(editedTitle);
    expect(state.noteWrites).toHaveLength(0);
    state.noteSaveStatus = 503;
    await link.click();
    await prompt.getByRole("button", { name: labels.unsavedChanges.save, exact: true }).click();
    await expect.poll(() => state.noteWrites.length).toBe(1);
    await settle(state);
    await expect(editor).toBeVisible();
    await expect(title).toHaveValue(editedTitle);
    await expect(prompt).toBeVisible();
    expect(state.note.title).toBe(originalNoteTitle);
    state.noteSaveStatus = 200;
    await prompt.getByRole("button", { name: labels.unsavedChanges.save, exact: true }).click();
    await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
    expect(state.noteWrites).toHaveLength(2);
    expect(state.note.title).toBe(editedTitle);
    await page.goBack();
    await expect(title).toHaveValue(editedTitle);
    await title.fill("SYNTHETIC DISCARD THIS EDIT");
    await link.click();
    await prompt.getByRole("button", { name: labels.unsavedChanges.discard, exact: true }).click();
    await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
    await page.goBack();
    await expect(title).toHaveValue(editedTitle);
    expect(state.noteWrites).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath("note-decisions.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
  });
}

test("access loss while preview bytes are pending cannot revive private selection or draft", async ({ page }) => {
  const state = await setup(page, "en", 1440, routePath);
  const reader = await openTranscript(page, "en");
  const row = page.locator(`#content-${contentId(9950)}`);
  await row.locator("label").click();
  state.holdBody = true;
  await reader.getByRole("button", { name: en.sessions.contents.excerpt.preview, exact: true }).click();
  await expect.poll(() => state.held.length).toBeGreaterThan(0);
  state.authorityStatus = 403;
  state.ownerBurst(1);
  await expect(page.getByRole("heading", { name: en.sessions.detail.loadError.title, exact: true })).toBeVisible();
  state.release();
  await settle(state);
  await expect(page.getByText(/SYNTHETIC COMPLETE RECORD/)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state.authorityStatus = 200;
  await page.reload();
  const restored = await openTranscript(page, "en");
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await expect(restored.getByRole("button", { name: en.sessions.contents.excerpt.note.resume, exact: true })).toHaveCount(0);
  await expect(restored.getByRole("button", { name: en.sessions.contents.excerpt.note.resumeDraft, exact: true })).toHaveCount(0);
});
