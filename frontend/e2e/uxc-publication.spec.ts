// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import {
  changedDigest, installPublicationFixture, publicationDigest, publicationNotes, publicationReads,
  publicationRoute, type PublicationFixture,
} from "./fixtures/uxc-publication-fixture";

// Run the actual SPA from a loopback dev server or frozen production preview.
// HTTP and WS are synthetic; this suite does not qualify backend authorization.
test.skip(process.env.BACKPLANE_E2E_PUBLICATION_FIXTURE !== "1", "Set BACKPLANE_E2E_PUBLICATION_FIXTURE=1 for synthetic AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce", hasTouch: true });
const states = new Map<Page, PublicationFixture>();
const locales = [["en", en], ["es", es], ["pt-BR", pt]] as const;
type Labels = typeof en | typeof es | typeof pt;
type FixtureNote = typeof publicationNotes[keyof typeof publicationNotes];

function sourceHashes() {
  return Object.fromEntries([
    "../src/features/notes/components/NotePublicationRevision.tsx",
    "../src/features/notes/api/use-note-publication-revision.ts",
    "../src/features/notes/components/NoteEditorMeta.tsx",
    "../src/i18n/locales/en.json", "../src/i18n/locales/es.json", "../src/i18n/locales/pt-BR.json",
    "./fixtures/uxc-publication-fixture.ts", "./uxc-publication.spec.ts",
  ].map((path) => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.release();
  await info.attach("publication-request-and-runtime-ledger", {
    body: JSON.stringify({
      syntheticOnly: true, candidate: process.env.BACKPLANE_E2E_PUBLICATION_CANDIDATE ?? "not supplied",
      baseURL: info.project.use.baseURL, browser: page.context().browser()?.version(), viewport: page.viewportSize(),
      sourceHashes: sourceHashes(), requests: state.requests, sockets: state.socketLedger,
      failedRequests: state.failures, unexpected: state.unexpected, console: state.console.all(),
    }, null, 2), contentType: "application/json",
  });
  if (!page.isClosed()) await info.attach("publication-final-view", { body: await page.screenshot(), contentType: "image/png" });
  // Retain failures even when the primary assertion failed, without replacing it.
  if (info.status === info.expectedStatus) {
    expect(state.unexpected).toEqual([]);
    expect(state.consoleViolations()).toEqual([]);
    expect(state.failures.filter(({ path, reason }) => reason !== "net::ERR_ABORTED" || !path.includes("/publication-revision"))).toEqual([]);
  }
  states.delete(page);
});

async function setup(page: Page, language: string, labels: Labels, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const state = await installPublicationFixture(page, language);
  states.set(page, state);
  await page.goto(publicationRoute);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("button", { name: labels.a11y.account.menu, exact: true })).toBeVisible();
  await expect(page.getByText(publicationNotes.matches.title, { exact: true })).toBeVisible();
  await settle(state);
  expect(publicationReads(state, "presence")).toEqual([]);
  expect(publicationReads(state, "comparison")).toEqual([]);
  return state;
}

async function settle(state: PublicationFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function openNote(page: Page, labels: Labels, entry: FixtureNote, touch = false) {
  const row = page.getByRole("button").filter({ has: page.getByText(entry.title, { exact: true }) });
  await expect(row).toHaveCount(1);
  if (touch) await row.tap();
  else await row.click();
  const sheet = page.getByRole("dialog", { name: labels.notes.editTitle, exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: labels.cards.titleLabel, exact: true })).toHaveValue(entry.title);
  await expect(sheet.locator(".tiptap")).toContainText(`SYNTHETIC SAVED BODY: ${entry.title}`);
  return { row, sheet };
}

async function closeNote(page: Page, labels: Labels, row: Locator) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: labels.notes.editTitle, exact: true })).not.toBeVisible();
  await expect(row).toBeFocused();
}

async function measure(page: Page, controls: Locator[], width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const measurements = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    measurements.push({ text: await control.textContent(), ...bounds });
  }
  await test.info().attach("publication-control-geometry", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
}

for (const [language, labels] of locales) {
  for (const width of [1440, 390]) {
    test(`${language} ${width}: authorized handoff comparison is deliberate and distinct from note history`, async ({ page }) => {
      const state = await setup(page, language, labels, width);
      const copy = labels.notes.publicationRevision;
      if (language === "en") expect(copy.action).toBe("Compare with original handoff");
      for (const entry of [publicationNotes.ui, publicationNotes.mcp, publicationNotes.otherAuthor]) {
        const { row, sheet } = await openNote(page, labels, entry, width === 390);
        await settle(state);
        await expect(sheet.getByRole("button", { name: copy.action, exact: true })).toHaveCount(0);
        expect(publicationReads(state, "comparison", entry.id)).toEqual([]);
        if (entry === publicationNotes.otherAuthor) expect(publicationReads(state, "presence", entry.id)).toEqual([]);
        else expect(publicationReads(state, "presence", entry.id).length).toBeGreaterThan(0);
        await closeNote(page, labels, row);
      }

      for (const [entry, expectedMessage] of [
        [publicationNotes.matches, copy.matches], [publicationNotes.differs, copy.differs],
        [publicationNotes.legacy, copy.revisionNotRecorded], [publicationNotes.unsupported, copy.unsupportedVersion],
      ] as const) {
        const { row, sheet } = await openNote(page, labels, entry, width === 390);
        const action = sheet.getByRole("button", { name: copy.action, exact: true });
        await expect(action).toBeVisible();
        await expect(action).toHaveAttribute("aria-expanded", "false");
        await settle(state);
        expect(publicationReads(state, "presence", entry.id).every((request) => request.responseBytes! < 128)).toBe(true);
        expect(publicationReads(state, "comparison", entry.id)).toEqual([]);
        // The saved body belongs to the editor. Presence never asks for a
        // second body, original snapshot, session body or comparison endpoint.
        expect(publicationReads(state, "note-body", entry.id).length).toBeGreaterThan(0);
        await action.focus();
        await page.keyboard.press("Enter");
        await expect(action).toBeFocused();
        await expect(action).toHaveAttribute("aria-expanded", "true");
        await expect(sheet.getByText(expectedMessage, { exact: true })).toBeVisible();
        await expect(sheet.getByText(copy.savedNoteScope, { exact: true })).toBeVisible();
        await settle(state);
        expect(publicationReads(state, "comparison", entry.id)).toHaveLength(1);
        const details = sheet.getByRole("button", { name: copy.details, exact: true });
        await details.focus();
        await page.keyboard.press("Space");
        await expect(details).toBeFocused();
        await expect(details).toHaveAttribute("aria-expanded", "true");
        await expect(sheet.getByText(copy.fieldScope, { exact: true })).toBeVisible();
        await expect(sheet.getByText(copy.version, { exact: true })).toHaveCount(0);
        if (entry === publicationNotes.matches) await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(2);
        if (entry === publicationNotes.differs) await expect(sheet.getByText(changedDigest, { exact: true })).toBeVisible();
        if (entry === publicationNotes.legacy) {
          await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(0);
          await expect(sheet.getByText(copy.matches, { exact: true })).toHaveCount(0);
          await expect(sheet.getByText(copy.differs, { exact: true })).toHaveCount(0);
        }
        await measure(page, [action, details], width);
        if (entry === publicationNotes.matches) await test.info().attach("publication-expanded-keyboard-focus", { body: await page.screenshot(), contentType: "image/png" });
        await action.focus();
        await page.keyboard.press("Enter");
        await expect(action).toHaveAttribute("aria-expanded", "false");
        await expect(sheet.getByText(expectedMessage, { exact: true })).toHaveCount(0);
        await closeNote(page, labels, row);
      }
    });
  }

  test(`${language} narrow: presence failure, loading and comparison retry remain distinct`, async ({ page }) => {
    const state = await setup(page, language, labels, 390);
    const entry = publicationNotes.matches, copy = labels.notes.publicationRevision;
    state.presenceStatus.set(entry.id, 503);
    const { sheet } = await openNote(page, labels, entry, true);
    await expect(sheet.getByText(copy.loadError, { exact: true })).toBeVisible();
    await expect(sheet.getByText(copy.noRecord, { exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: copy.action, exact: true })).toHaveCount(0);
    expect(publicationReads(state, "comparison")).toEqual([]);
    state.presenceStatus.set(entry.id, 200);
    await sheet.getByRole("button", { name: copy.retry, exact: true }).tap();
    const action = sheet.getByRole("button", { name: copy.action, exact: true });
    await expect(action).toBeVisible();
    state.comparisonStatus.set(entry.id, 503);
    const release = state.holdComparison(entry.id);
    await action.tap();
    await expect(sheet.getByText(copy.loading, { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: copy.checkAgain, exact: true })).toBeDisabled();
    await test.info().attach("publication-loading", { body: await page.screenshot(), contentType: "image/png" });
    release();
    await expect(sheet.getByText(copy.loadError, { exact: true })).toBeVisible();
    state.comparisonStatus.set(entry.id, 200);
    await sheet.getByRole("button", { name: copy.retry, exact: true }).tap();
    await expect(sheet.getByText(copy.matches, { exact: true })).toBeVisible();
    await settle(state);
    expect(publicationReads(state, "comparison", entry.id).map((request) => request.status)).toEqual([503, 200]);
  });
}

async function refreshIdentityThroughBrowserReconnect(page: Page, state: PublicationFixture, status: number) {
  const before = state.requests.length;
  state.identityStatus = status;
  // /me is stale after five minutes. Native browser online recovery exercises
  // React Query's real reconnect path, without reaching into its cache.
  await page.clock.fastForward(5 * 60_000 + 1000);
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.context().setOffline(false);
  await expect.poll(() => state.requests.slice(before).some((request) => request.path === "/api/me" && request.status === status)).toBe(true);
}

test("identity denial removes shown proof while a transient identity outage preserves authorized usefulness", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-18T18:00:00Z") });
  const state = await setup(page, "en", en, 1440);
  const { sheet } = await openNote(page, en, publicationNotes.matches);
  const copy = en.notes.publicationRevision;
  await sheet.getByRole("button", { name: copy.action, exact: true }).click();
  await expect(sheet.getByText(copy.matches, { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: copy.details, exact: true }).click();
  await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(2);
  await state.closeSockets();
  await refreshIdentityThroughBrowserReconnect(page, state, 503);
  await settle(state);
  await expect(sheet.getByRole("button", { name: copy.action, exact: true })).toBeVisible();
  await expect(sheet.getByText(copy.matches, { exact: true })).toBeVisible();
  const release = state.holdComparison(publicationNotes.matches.id);
  await refreshIdentityThroughBrowserReconnect(page, state, 403);
  await expect(sheet.getByRole("button", { name: copy.action, exact: true })).toHaveCount(0);
  await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(0);
  await expect(sheet.getByText(copy.matches, { exact: true })).toHaveCount(0);
  release();
  await settle(state);
  await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state }))).not.toContain(publicationDigest);
});

test("a delayed first comparison cannot restore proof after identity denial", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-18T18:00:00Z") });
  const state = await setup(page, "en", en, 390);
  const { sheet } = await openNote(page, en, publicationNotes.matches, true);
  const copy = en.notes.publicationRevision;
  const release = state.holdComparison(publicationNotes.matches.id);
  await sheet.getByRole("button", { name: copy.action, exact: true }).tap();
  await expect(sheet.getByText(copy.loading, { exact: true })).toBeVisible();
  await state.closeSockets();
  await refreshIdentityThroughBrowserReconnect(page, state, 403);
  await expect(sheet.getByRole("button", { name: copy.action, exact: true })).toHaveCount(0);
  release();
  await settle(state);
  await expect(sheet.getByText(copy.matches, { exact: true })).toHaveCount(0);
  await expect(sheet.getByText(publicationDigest, { exact: true })).toHaveCount(0);
});
