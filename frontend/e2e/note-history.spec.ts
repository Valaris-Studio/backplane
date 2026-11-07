// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { publicationRoute } from "./fixtures/uxc-publication-fixture";
import { baselineNote, draftBody, draftTitle, handoffNote, historyNote, installHistoryFixture,
  latestRevision, retainedMarker, revisionDetail, sha, sourceLinkAfter, sourceLinkBefore, type HistoryFixture } from "./note-history-fixtures";

test.skip(process.env.BACKPLANE_E2E_B04_FIXTURE !== "1", "Set BACKPLANE_E2E_B04_FIXTURE=1 for synthetic built-AppShell history qualification");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce", hasTouch: true });
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const copy = {
  en: { action: /^History$/, dialog: /^(Note )?history$/i, revision: "Revision", previous: /^Previous revision$/, older: /Load older revisions|Older revisions/,
    retention: /earlier versions|previous versions/i, current: /Current saved revision|Current saved version/,
    loading: /Loading history|Loading revisions/, error: /Could not load|History could not be loaded|Unable to load|History unavailable/,
    retry: /Try again|Retry/, baseline: /baseline|history starts/i, unknown: /unknown/i, unavailable: /no longer available|access|unavailable/i },
  es: { action: /^Historial$/, dialog: /^Historial(?: de la nota)?$/i, revision: "Revisión", previous: /^Revisión anterior$/, older: /Cargar revisiones anteriores|Revisiones anteriores/,
    retention: /versiones anteriores/i, current: /Revisión guardada actual|Versión guardada actual/,
    loading: /Cargando (?:historial|revisiones)/, error: /No se pudo cargar|No se pudieron cargar|Historial no disponible/,
    retry: /Reintentar|Intentar de nuevo/, baseline: /base|historial comienza/i, unknown: /desconocid/i, unavailable: /disponible|acceso/i },
  "pt-BR": { action: /^Histórico$/, dialog: /^Histórico(?: da nota)?$/i, revision: "Revisão", previous: /^Revisão anterior$/, older: /Carregar revisões anteriores|Revisões anteriores/,
    retention: /versões anteriores/i, current: /Revisão salva atual|Versão salva atual/,
    loading: /Carregando (?:histórico|revisões)/, error: /Não foi possível carregar|Histórico indisponível/,
    retry: /Tentar novamente/, baseline: /base|histórico começa/i, unknown: /desconhecid/i, unavailable: /disponível|acesso/i },
};
const manifestPath = process.env.BACKPLANE_E2E_B04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string> } : null;
const files = ["e2e/note-history.spec.ts", "e2e/note-history-fixtures.ts", "e2e/fixtures/uxc-publication-fixture.ts", "playwright.config.ts"];
const hashes = () => Object.fromEntries(files.map((path) => [path, sha(readFileSync(path))]));
const runs = new Map<Page, { state: HistoryFixture; locale: Locale; inputs: ReturnType<typeof hashes>; observations: unknown[] }>();
const historyDialog = (page: Page, locale: Locale) => page.getByRole("dialog", { name: copy[locale].dialog });
const revisionRow = (dialog: Locator, locale: Locale, revision: number) => dialog.getByRole("button", { name: new RegExp(`^${copy[locale].revision} ${revision}(?:\\D|$)`) });

async function settled(state: HistoryFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function setup(page: Page, locale: Locale, width: number) {
  expect(manifest, "Bind qualification to a preserved production-build manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const state = await installHistoryFixture(page, locale);
  runs.set(page, { state, locale, inputs: hashes(), observations: [] });
  await page.goto(publicationRoute);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(historyNote.title, { exact: true })).toBeVisible();
  await settled(state);
  expect(state.historyRequests.filter((request) => request.kind !== "note")).toEqual([]);
  return state;
}

async function openNote(page: Page, locale: Locale, note = historyNote) {
  const row = page.getByRole("button").filter({ has: page.getByText(note.title, { exact: true }) });
  if (page.viewportSize()?.width === 390) await row.tap(); else await row.click();
  const sheet = page.getByRole("dialog", { name: catalogs[locale].notes.editTitle, exact: true });
  await expect(sheet.getByRole("textbox", { name: catalogs[locale].cards.titleLabel, exact: true })).toHaveValue(note.title);
  await expect(sheet.locator(".tiptap[contenteditable=true]")).toContainText(retainedMarker);
  return sheet;
}

async function openHistory(page: Page, locale: Locale, sheet: Locator) {
  const editorRoot = await sheet.elementHandle();
  const opener = sheet.getByRole("button", { name: copy[locale].action });
  await expect(opener, "B04 adds History to ordinary authorized notes").toBeVisible();
  await expect(sheet.getByText(copy[locale].retention)).toBeVisible();
  if (page.viewportSize()?.width === 390) await opener.tap();
  else { await opener.focus(); await page.keyboard.press("Enter"); }
  const dialog = historyDialog(page, locale);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await editorRoot!.evaluate((element) => ({ connected: element.isConnected,
    inert: Boolean(element.closest("[inert]")), hidden: Boolean(element.closest('[aria-hidden="true"]')),
  }))).toEqual({ connected: true, inert: true, hidden: true });
  return { dialog, opener };
}

async function expandGroups(dialog: Locator) {
  const groups = dialog.getByRole("button", { expanded: false });
  while (await groups.count()) await groups.first().click();
}

async function observe(page: Page, phase: string, dialog: Locator) {
  const geometry = await dialog.boundingBox();
  expect(geometry).not.toBeNull();
  expect(geometry!.x).toBeGreaterThanOrEqual(0);
  expect(geometry!.y).toBeGreaterThanOrEqual(0);
  expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  const observation = await page.evaluate(() => ({ href: location.href, history: history.state,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, touch: navigator.maxTouchPoints }));
  expect(observation.overflow).toBeLessThanOrEqual(1); expect(observation.reducedMotion).toBe(true);
  runs.get(page)!.observations.push({ phase, geometry, ...observation });
  await page.screenshot({ path: test.info().outputPath(`${phase}.png`) });
  await test.info().attach(`${phase}-accessibility`, { body: await dialog.ariaSnapshot(), contentType: "text/plain" });
}

async function assertPrivateState(page: Page) {
  const state = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [draftTitle, draftBody, retainedMarker, sourceLinkAfter]) expect(state).not.toContain(value);
}

async function assertHistoryFocus(page: Page, dialog: Locator) {
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  run.state.release();
  await Promise.all(run.state.pendingAssets);
  await expect.poll(() => run.state.inflight).toBe(0);
  const ledger = info.outputPath("note-history-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Synthetic B03-shaped HTTP/WebSocket through actual built App/AppShell; not live authorization, backend mutation or installation proof.",
    status: info.status, locale: run.locale, browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    baseURL: info.project.use.baseURL, candidate: manifest && { head: manifest.head, tree: manifest.tree },
    manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), inputsBefore: run.inputs, inputsAfter: hashes(),
    assets: run.state.assets, observations: run.observations, requests: run.state.historyRequests,
    shellRequests: run.state.requests, sockets: run.state.socketLedger, unexpected: run.state.unexpected,
    console: run.state.console.all(), failures: run.state.failures,
  }, null, 2));
  await info.attach("note-history-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-view.png") });
  expect.soft(hashes()).toEqual(run.inputs);
  expect.soft(run.state.assets.some((asset) => asset.key === "index.html")).toBe(true);
  expect.soft(run.state.assets.some((asset) => asset.key.endsWith(".js"))).toBe(true);
  expect.soft(run.state.assets.some((asset) => asset.key.endsWith(".css"))).toBe(true);
  expect.soft(run.state.assets.filter((asset) => asset.status !== 200 || asset.sha256 !== manifest?.files[asset.key])).toEqual([]);
  expect.soft(run.state.unexpected).toEqual([]);
  expect.soft(run.state.consoleViolations()).toEqual([]);
  expect.soft(run.state.failures.filter(({ reason }) => reason !== "net::ERR_ABORTED")).toEqual([]);
  runs.delete(page);
});

for (const locale of ["en", "es", "pt-BR"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${locale} ${width} note history`, () => {
      test.use({ hasTouch: width === 390 });
      test("rich saved revisions preserve dirty title/body through keyboard or touch History and close", async ({ page }) => {
        const state = await setup(page, locale, width);
        const sheet = await openNote(page, locale);
        await expect(sheet.getByRole("button", { name: catalogs[locale].notes.publicationRevision.action, exact: true })).toHaveCount(0);
        const title = sheet.getByRole("textbox", { name: catalogs[locale].cards.titleLabel, exact: true });
        const body = sheet.locator(".tiptap[contenteditable=true]");
        await title.fill(draftTitle); await body.fill(draftBody);
        const titleNode = await title.elementHandle(), bodyNode = await body.elementHandle();
        const before = await page.evaluate(() => ({ href: location.href, entry: history.state }));
        const { dialog, opener } = await openHistory(page, locale, sheet);
        await expect(revisionRow(dialog, locale, latestRevision)).toBeVisible();
        await settled(state);
        expect(state.historyRequests.filter((request) => request.kind === "compare" || request.kind === "detail")).toEqual([]);
        await revisionRow(dialog, locale, latestRevision).click();
        await expect(dialog).toContainText(retainedMarker);
        await settled(state);
        expect(state.historyRequests.filter((request) => request.kind === "compare").map(({ from, to }) => [from, to])).toEqual([[53, 54]]);
        await expect(dialog.getByText("Synthetic Elena", { exact: false }).first()).toBeVisible();
        await expect(dialog.getByText("Synthetic Sancho", { exact: false }).first()).toBeVisible();
        await expect(dialog.locator(`time[datetime="${revisionDetail(54).recorded_at}"]`).first()).toBeVisible();
        await expect(dialog.locator("strong").filter({ hasText: retainedMarker })).toBeVisible();
        await expect(dialog.locator("em").filter({ hasText: retainedMarker })).toBeVisible();
        await expect(dialog.locator(`a[href="${sourceLinkBefore}"]`)).toBeVisible();
        await expect(dialog.locator(`a[href="${sourceLinkAfter}"]`)).toBeVisible();
        await expect(dialog.getByText(sourceLinkBefore, { exact: false }).first()).toBeVisible();
        await expect(dialog.getByText(sourceLinkAfter, { exact: false }).first()).toBeVisible();
        await expect(dialog.getByRole("heading", { level: 3, name: "Evidence structure", exact: true })).toBeVisible();
        await expect(dialog.getByRole("heading", { level: 2, name: "Evidence structure", exact: true })).toBeVisible();
        await expect(dialog.getByText("Synthetic metadata finding", { exact: false })).toBeVisible();
        await expect(dialog).not.toContainText(draftBody);
        await observe(page, "rich-saved-comparison", dialog);
        if (width === 390) {
          const beforeRichHeading = dialog.getByRole("heading", { level: 3, name: "Evidence structure", exact: true });
          await beforeRichHeading.scrollIntoViewIfNeeded();
          await expect(beforeRichHeading).toBeInViewport();
          await observe(page, "rich-saved-body", dialog);
        }
        await assertHistoryFocus(page, dialog);

        expect(await dialog.getByRole("button", { expanded: false }).count()).toBeGreaterThan(0);
        await expandGroups(dialog);
        await revisionRow(dialog, locale, 52).click();
        await settled(state);
        expect(state.historyRequests.some((request) => request.kind === "compare" && request.from === 51 && request.to === 52)).toBe(true);
        const currentSaved = dialog.getByRole("button", { name: copy[locale].current });
        await expect(currentSaved).toBeEnabled();
        const targetRevisionLabel = catalogs[locale].notes.history.revision.replace("{{revision}}", String(latestRevision));
        const exactTargetRevision = new RegExp(`${targetRevisionLabel}(?!\\d)`);
        await expect(currentSaved).toContainText(exactTargetRevision);
        await expect(currentSaved).toHaveAccessibleName(exactTargetRevision);
        await currentSaved.click();
        await expect(dialog).toContainText("Synthetic metadata finding");
        await settled(state);
        expect(state.historyRequests.some((request) => request.kind === "compare" && request.from === 52 && request.to === 54)).toBe(true);
        await expect(dialog).not.toContainText(draftBody);
        await dialog.getByRole("button", { name: copy[locale].previous }).click();
        const older = dialog.getByRole("button", { name: copy[locale].older });
        await older.click();
        await expect(revisionRow(dialog, locale, 1)).toHaveCount(1);
        await expandGroups(dialog);
        for (let revision = 1; revision <= latestRevision; revision++) await expect(revisionRow(dialog, locale, revision)).toHaveCount(1);
        expect(state.historyRequests.filter((request) => request.kind === "list").map((request) => request.before)).toEqual([55, 5]);
        await revisionRow(dialog, locale, 1).click();
        await expect(dialog.getByText(copy[locale].baseline).first()).toBeVisible();
        await expect(dialog.getByText(copy[locale].unknown).first()).toBeVisible();
        await settled(state);
        expect(state.historyRequests.filter((request) => request.kind === "compare").some((request) => request.from === 0 || request.to === 0)).toBe(false);
        await observe(page, "baseline-and-every-revision", dialog);
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(opener).toBeFocused();
        await expect(title).toHaveValue(draftTitle); await expect(body).toHaveText(draftBody);
        expect(await title.evaluate((node, original) => node === original, titleNode)).toBe(true);
        expect(await body.evaluate((node, original) => node === original, bodyNode)).toBe(true);
        await expect(page.getByTestId("unsaved-changes-prompt")).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: catalogs[locale].common.save, exact: true })).toBeEnabled();
        expect(await page.evaluate(() => ({ href: location.href, entry: history.state }))).toEqual(before);
        expect(state.historyRequests.every((request) => request.method === "GET")).toBe(true);
        await assertPrivateState(page);
      });
    });
  }
}

test("first baseline has an unknown earlier author and no invented previous comparison", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  const sheet = await openNote(page, "en", baselineNote);
  const { dialog } = await openHistory(page, "en", sheet);
  await revisionRow(dialog, "en", 1).click();
  await expect(dialog.getByText(copy.en.baseline).first()).toBeVisible();
  await expect(dialog.getByText(copy.en.unknown).first()).toBeVisible();
  await expect(dialog).toContainText(retainedMarker);
  await settled(state);
  expect(state.historyRequests.filter((request) => request.kind === "compare")).toEqual([]);
  expect(state.historyRequests.some((request) => request.kind === "detail" && request.path.endsWith("/1"))).toBe(true);
});

test("history and digest-only original handoff remain distinct", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  const sheet = await openNote(page, "en", handoffNote);
  const publication = en.notes.publicationRevision;
  await sheet.getByRole("button", { name: publication.action, exact: true }).click();
  await expect(sheet.getByText(publication.matches, { exact: true })).toBeVisible();
  expect(state.historyRequests.filter((request) => request.kind !== "note")).toEqual([]);
  const { dialog } = await openHistory(page, "en", sheet);
  await revisionRow(dialog, "en", latestRevision).click();
  await expect(dialog).toContainText(retainedMarker);
  await expect(dialog).not.toContainText(publication.matches);
  await page.keyboard.press("Escape");
  await expect(sheet.getByText(publication.matches, { exact: true })).toBeVisible();
  expect(state.requests.filter((request) => request.kind === "comparison")).toHaveLength(1);
});

test("loading, transient history failure and explicit retry are separate from an empty history", async ({ page }) => {
  const state = await setup(page, "en", 390);
  const sheet = await openNote(page, "en");
  state.historyStatus = 503;
  const release = state.holdHistory("list");
  const { dialog } = await openHistory(page, "en", sheet);
  await expect(dialog.getByText(copy.en.loading).first()).toBeVisible();
  await observe(page, "loading", dialog);
  release();
  await expect(dialog.getByText(copy.en.error).first()).toBeVisible();
  await expect(revisionRow(dialog, "en", latestRevision)).toHaveCount(0);
  state.historyStatus = 200;
  await dialog.getByRole("button", { name: copy.en.retry }).click();
  await expect(revisionRow(dialog, "en", latestRevision)).toBeVisible();
  await revisionRow(dialog, "en", latestRevision).click();
  await expect(dialog).toContainText(retainedMarker);
  await settled(state);
  expect(state.historyRequests.filter((request) => request.kind === "list").map((request) => request.status)).toEqual([503, 200]);
});

test("a current saved comparison is unavailable when an old writer changed the digest", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  state.currentDigestMismatch = true;
  const sheet = await openNote(page, "en");
  const { dialog } = await openHistory(page, "en", sheet);
  await revisionRow(dialog, "en", latestRevision).click();
  await expect(dialog).toContainText(retainedMarker);
  await expandGroups(dialog);
  await revisionRow(dialog, "en", 52).click();
  const current = dialog.getByRole("button", { name: copy.en.current });
  await expect(current).toBeDisabled();
  await expect(dialog.getByText(/current.*(?:recorded|history)|(?:recorded|history).*current/i).first()).toBeVisible();
  await settled(state);
  expect(state.historyRequests.filter((request) => request.kind === "compare").every((request) => request.to !== 54 || request.from === 53)).toBe(true);
});

test("identity denial clears retained text and a late successful comparison cannot restore it", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
  const state = await setup(page, "en", 1440);
  const sheet = await openNote(page, "en");
  const { dialog } = await openHistory(page, "en", sheet);
  await revisionRow(dialog, "en", latestRevision).click();
  await expect(dialog).toContainText(retainedMarker);
  await expandGroups(dialog);
  const release = state.holdHistory("compare");
  await revisionRow(dialog, "en", 52).click();
  await expect.poll(() => state.historyRequests.some((request) => request.kind === "compare" && request.to === 52)).toBe(true);
  state.identityStatus = 403;
  const before = state.requests.length;
  await state.closeSockets();
  await page.clock.fastForward(5 * 60_000 + 1000);
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.context().setOffline(false);
  await expect.poll(() => state.requests.slice(before).some((request) => request.path === "/api/me" && request.status === 403)).toBe(true);
  await expect(historyDialog(page, "en").getByText(retainedMarker, { exact: false })).toHaveCount(0);
  release();
  await settled(state);
  await expect(historyDialog(page, "en").getByText(retainedMarker, { exact: false })).toHaveCount(0);
  await assertPrivateState(page);
});


test("note deletion removes the shown history before a prior selected-pair response arrives", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  const sheet = await openNote(page, "en");
  const { dialog } = await openHistory(page, "en", sheet);
  await revisionRow(dialog, "en", latestRevision).click();
  await expect(dialog).toContainText(retainedMarker);
  await expandGroups(dialog);
  const release = state.holdHistory("compare");
  await revisionRow(dialog, "en", 52).click();
  await expect.poll(() => state.historyRequests.some((request) => request.kind === "compare" && request.to === 52)).toBe(true);
  state.historyStatus = 404;
  state.publishNote("deleted");
  await expect(historyDialog(page, "en").getByText(retainedMarker, { exact: false })).toHaveCount(0);
  release();
  await settled(state);
  await expect(historyDialog(page, "en").getByText(retainedMarker, { exact: false })).toHaveCount(0);
  await assertPrivateState(page);
});
