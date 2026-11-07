// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { privateBodyReads } from "./fixtures/a04-related-continuity";
import { boardId, contentsPath, routePath, session, sessionPath, sha, slug, windowRequests } from "./fixtures/session-window-fixture";
import { noteHref, originalNoteTitle, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { beginningLabel, bodyOffset, callKey, callMatchLabel, groupedLaterLabel, groupedOriginId, installB02Fixture, nestedField, oldContentId,
  oldMatchLabel, originalContentId, privateQuery, searchPath, type B02Fixture } from "./fixtures/b02-find-in-session";

test.skip(process.env.BACKPLANE_E2E_B02_FIXTURE !== "1", "Set BACKPLANE_E2E_B02_FIXTURE=1 for the synthetic built-AppShell journey");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(90_000);

const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const findCopy = {
  en: { title: "Find in session", close: "Close find", next: "Next match", previous: "Previous match", continue: "Continue searching",
    again: "Search again", back: "Back to where you were", beginning: "Show from the beginning", failures: "Failures only", work: "Work only",
    returnAnchor: "Return to original record",
    stale: /new activity|session changed/i, partial: /so far/i, pending: /index/i, empty: /no matches/i, unavailable: /unavailable|no longer available/i },
  es: { title: "Buscar en la sesión", close: "Cerrar búsqueda", next: "Siguiente coincidencia", previous: "Coincidencia anterior", continue: "Seguir buscando",
    again: "Buscar de nuevo", back: "Volver a donde estabas", beginning: "Mostrar desde el principio", failures: "Solo fallos", work: "Solo trabajo",
    returnAnchor: "Volver al registro original",
    stale: /actividad nueva|nueva actividad|sesión cambió|sesión ha cambiado/i, partial: /hasta ahora/i, pending: /índice|index/i, empty: /sin coincidencias|no hay coincidencias/i, unavailable: /no disponible|ya no está disponible/i },
  "pt-BR": { title: "Buscar na sessão", close: "Fechar busca", next: "Próxima correspondência", previous: "Correspondência anterior", continue: "Continuar buscando",
    again: "Buscar novamente", back: "Voltar para onde você estava", beginning: "Mostrar desde o início", failures: "Somente falhas", work: "Somente trabalho",
    returnAnchor: "Voltar ao registro original",
    stale: /nova atividade|sessão mudou|sessão foi alterada/i, partial: /até agora/i, pending: /índice|index/i, empty: /nenhuma correspondência|sem correspondências/i, unavailable: /indisponível|não está mais disponível/i },
};
const manifestPath = process.env.BACKPLANE_E2E_B02_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string> } : null;
const inputs = ["e2e/b02-find-in-session.spec.ts", "e2e/fixtures/b02-find-in-session.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts"];
const inputHashes = () => Object.fromEntries(inputs.map((path) => [path, sha(readFileSync(path))]));
const runs = new Map<Page, { state: B02Fixture; locale: Locale; before: ReturnType<typeof inputHashes>; observations: unknown[] }>();
const findPanel = (page: Page, locale: Locale) => page.getByRole("region", { name: findCopy[locale].title, exact: true });
const findInput = (page: Page, locale: Locale) => page.getByRole("searchbox", { name: findCopy[locale].title, exact: true });
const result = (page: Page, locale: Locale, label: string) => findPanel(page, locale).getByRole("button").filter({ hasText: label });
const transcript = (page: Page, locale: Locale) => page.getByRole("region", { name: catalogs[locale].sessions.contents.title, exact: true });
const historyEntry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx, href: location.href }));
const handoffRequests = (state: B02Fixture) => state.requests.filter((request) => request.path.endsWith("/notes/from-excerpt"));

async function settled(state: B02Fixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function setup(page: Page, locale: Locale, width: number, href = routePath) {
  expect(manifest, "Bind the browser run to the supplied preserved production build").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const state = await installB02Fixture(page, locale);
  runs.set(page, { state, locale, before: inputHashes(), observations: [] });
  await page.goto(href);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await settled(state);
  return state;
}

async function openFind(page: Page, locale: Locale, touch: boolean) {
  const opener = page.getByRole("button", { name: findCopy[locale].title, exact: true });
  await expect(opener, "B02 supplies a single Find control shared by both reader tabs").toBeVisible();
  if (touch) await opener.tap();
  else await page.keyboard.press("/");
  await expect(findInput(page, locale)).toBeFocused();
  await expect(findPanel(page, locale)).toBeVisible();
}

async function openTranscript(page: Page, locale: Locale) {
  await page.getByRole("tab", { name: catalogs[locale].sessions.detail.tabs.transcript, exact: true }).click();
  await expect(transcript(page, locale)).toBeVisible();
  return transcript(page, locale);
}

async function observe(page: Page, phase: string) {
  const view = await page.evaluate(() => ({ href: location.href, history: history.state,
    focus: { id: document.activeElement?.id, text: document.activeElement?.getAttribute("aria-label") },
    width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth,
  }));
  runs.get(page)!.observations.push({ phase, ...view });
  expect(view.reducedMotion).toBe(true); expect(view.overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath(`${phase}.png`) });
}

async function touchTargets(page: Page, locale: Locale) {
  if (page.viewportSize()?.width !== 390) return;
  const candidates = findPanel(page, locale).getByRole("button")
    .or(findPanel(page, locale).getByRole("checkbox"))
    .or(findPanel(page, locale).getByRole("switch"))
    .or(page.getByRole("button", { name: findCopy[locale].title, exact: true }))
    .or(page.getByRole("button", { name: findCopy[locale].back, exact: true }));
  const targets = await candidates.evaluateAll((elements) => elements.filter((element) => element.getClientRects().length).map((element) => {
    const target = element instanceof HTMLInputElement ? element.closest("label") ?? element : element;
    const box = target.getBoundingClientRect();
    return { name: element.getAttribute("aria-label") ?? element.textContent, width: box.width, height: box.height };
  }));
  expect(targets.length).toBeGreaterThan(1);
  expect(targets.filter((target) => target.width < 44 || target.height < 44)).toEqual([]);
}

async function privateStateAbsent(page: Page) {
  const publicState = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [privateQuery, privateQuery.trim(), privateDraftTitle, privateDraftBody, oldMatchLabel, callMatchLabel]) {
    expect(publicState).not.toContain(value);
  }
}

async function prepareHandoff(page: Page, locale: Locale, reader: Locator) {
  const labels = catalogs[locale].sessions.contents.excerpt;
  const selected = page.locator(`#content-${originalContentId}`);
  await reader.getByRole("combobox", { name: catalogs[locale].sessions.contents.navigation.label, exact: true }).selectOption(originalContentId);
  await expect(selected).toBeFocused();
  await selected.locator("label").click();
  await expect(selected.getByRole("checkbox")).toBeChecked();
  await reader.getByRole("button", { name: labels.preview, exact: true }).click();
  const preview = page.getByRole("dialog", { name: labels.title, exact: true });
  await expect(preview.getByLabel(labels.previewLabel)).toHaveValue(/SYNTHETIC COMPLETE RECORD 9950/);
  await preview.getByRole("button", { name: labels.note.share, exact: true }).click();
  const draft = page.getByRole("dialog", { name: labels.note.share, exact: true });
  await draft.getByRole("combobox", { name: labels.note.workspace, exact: true }).selectOption(slug);
  await draft.getByRole("combobox", { name: labels.note.board, exact: true }).selectOption(boardId);
  await draft.getByRole("textbox", { name: labels.note.title, exact: true }).fill(privateDraftTitle);
  await draft.getByRole("region", { name: labels.note.content, exact: true }).locator("[contenteditable]").fill(privateDraftBody);
  await draft.getByRole("button", { name: labels.note.save, exact: true }).click();
  await expect(draft.getByRole("alert")).toHaveText(labels.note.unknown);
  await draft.getByRole("button", { name: labels.note.hide, exact: true }).click();
  await reader.getByRole("combobox", { name: catalogs[locale].sessions.contents.navigation.label, exact: true }).selectOption(originalContentId);
  await expect(selected).toBeFocused();
  return selected;
}

async function assertDraftRetry(page: Page, locale: Locale, state: B02Fixture, initialPayload: string) {
  const labels = catalogs[locale].sessions.contents.excerpt.note;
  await transcript(page, locale).getByRole("button", { name: labels.resume, exact: true }).click();
  const draft = page.getByRole("dialog", { name: labels.share, exact: true });
  await expect(draft.getByRole("textbox", { name: labels.title, exact: true })).toHaveValue(privateDraftTitle);
  await expect(draft.getByRole("region", { name: labels.content, exact: true })).toContainText(privateDraftBody);
  await draft.getByRole("button", { name: labels.retry, exact: true }).click();
  await expect(draft.getByRole("alert")).toHaveText(labels.unknown);
  await settled(state);
  expect(handoffRequests(state)).toHaveLength(2);
  expect(handoffRequests(state)[1]!.payload).toBe(initialPayload);
  await draft.getByRole("button", { name: labels.hide, exact: true }).click();
}

async function assertNoAutomaticSearch(page: Page, state: B02Fixture, locale: Locale) {
  const count = state.searches.length;
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  state.ownerBurst(4);
  await expect(findPanel(page, locale).getByText(findCopy[locale].stale)).toBeVisible();
  await page.waitForTimeout(2300);
  await settled(state);
  expect(state.searches).toHaveLength(count);
  const connections = state.socketsOpened;
  await state.disconnect();
  await expect.poll(() => state.socketsOpened).toBe(connections + 1);
  await page.waitForTimeout(2300);
  await settled(state);
  expect(state.searches).toHaveLength(count);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state } = run;
  state.releaseSearch(); state.releaseRelated(); state.release();
  await Promise.all(state.pendingAssets);
  await expect.poll(() => state.pendingProofs + state.inflight).toBe(0);
  state.observationCutoff = Date.now();
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const consoleErrors = state.consoleReceipts.filter((entry) => {
    if (entry.type !== "error") return false;
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(entry.text)?.[1];
    if (!status || !entry.url) return true;
    const url = new URL(entry.url);
    return !state.responseReceipts.some((response) => response.path === url.pathname && response.query === url.search
      && response.status === Number(status) && [401, 403, 404, 409, 410, 503].includes(response.status));
  });
  const ledger = info.outputPath("b02-find-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Synthetic B01-shaped HTTP/WebSocket through actual built AppShell. This proves neither deployed historical indexing nor live authorization.",
    status: info.status, locale: run.locale, browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    candidate: manifest && { head: manifest.head, tree: manifest.tree }, inputsBefore: run.before, inputsAfter: inputHashes(),
    assets, observations: run.observations, searches: state.searches, requests: state.requests, sockets: state.socketLedger,
    unexpected: state.unexpected, consoleErrors, failures: state.failures, cutoff: state.observationCutoff,
  }, null, 2));
  await info.attach("b02-find-ledger", { path: ledger, contentType: "application/json" });
  expect.soft(inputHashes()).toEqual(run.before);
  expect.soft(assets.some((asset) => asset.manifestKey === "index.html")).toBe(true);
  expect.soft(assets.some((asset) => asset.manifestKey.endsWith(".js"))).toBe(true);
  expect.soft(assets.some((asset) => asset.manifestKey.endsWith(".css"))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(consoleErrors).toEqual([]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith(" net::ERR_ABORTED"))).toEqual([]);
  runs.delete(page);
});

for (const locale of ["en", "es", "pt-BR"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${locale} ${width} Find`, () => {
      test.use({ hasTouch: width === 390 });

      test("exact old matches preserve an investigation through close, live recovery, resize and Back/Return", async ({ page }) => {
        const state = await setup(page, locale, width);
        const reader = await openTranscript(page, locale);
        const selected = await prepareHandoff(page, locale, reader);
        await settled(state);
        const originalTop = await selected.evaluate((element) => element.getBoundingClientRect().top);
        const entry = await historyEntry(page);
        const savePayload = handoffRequests(state)[0]!.payload!;
        expect(JSON.parse(savePayload).excerpt_source.items).toHaveLength(1);
        const readsBeforeFind = privateBodyReads(state).length;
        const callsBeforeFind = state.requests.filter((request) => request.path === `${sessionPath}/calls`).length;

        await openFind(page, locale, width === 390);
        await findInput(page, locale).fill(privateQuery);
        await expect(result(page, locale, oldMatchLabel)).toBeVisible();
        await expect(result(page, locale, callMatchLabel)).toBeVisible();
        await settled(state);
        expect(state.searches).toHaveLength(1);
        expect(state.searches[0]!.request.q).toBe(privateQuery);
        expect(privateBodyReads(state)).toHaveLength(readsBeforeFind);
        expect(await historyEntry(page)).toEqual(entry);
        await privateStateAbsent(page); await observe(page, "results-without-body-reads");
        await touchTargets(page, locale);

        const oldResult = result(page, locale, oldMatchLabel);
        if (width === 390) await oldResult.tap(); else await oldResult.click();
        const oldRecord = page.locator(`#content-${oldContentId}`);
        await expect(oldRecord.locator("mark")).toHaveText(privateQuery);
        await expect(oldResult).toBeFocused();
        await expect(oldRecord.getByText(beginningLabel, { exact: false })).toHaveCount(0);
        await settled(state);
        expect(windowRequests(state).some((request) => request.mode === "anchor" && request.query.includes(oldContentId))).toBe(true);
        const bodyReads = state.requests.filter((request) => request.path === `${contentsPath}/${oldContentId}/body`);
        expect(bodyReads).toHaveLength(1);
        expect(new URLSearchParams(bodyReads[0]!.query).get("offset")).toBe(String(bodyOffset));
        await touchTargets(page, locale);
        await oldRecord.getByRole("button", { name: findCopy[locale].beginning, exact: true }).click();
        await expect(oldRecord).toContainText(beginningLabel);
        await expect(oldRecord.locator("mark")).toHaveCount(0);
        await settled(state);
        expect(state.requests.filter((request) => request.path === `${contentsPath}/${oldContentId}/body`)
          .map((request) => Number(new URLSearchParams(request.query).get("offset") ?? 0))).toEqual([bodyOffset, 0]);

        await findInput(page, locale).focus();
        await findInput(page, locale).press("Enter");
        await expect(page.getByRole("tab", { name: catalogs[locale].sessions.detail.tabs.timeline, exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("region").filter({ has: page.getByText(nestedField, { exact: true }) }).last().locator("mark")).toHaveText(privateQuery);
        await expect(findInput(page, locale)).toBeFocused();
        await settled(state);
        expect(state.requests.filter((request) => request.path === `${sessionPath}/calls/${callKey}`)).toHaveLength(1);
        expect(state.requests.filter((request) => request.path === `${sessionPath}/calls`)).toHaveLength(callsBeforeFind);
        await findInput(page, locale).press("Shift+Enter");
        await expect(oldRecord.locator("mark")).toHaveText(privateQuery);
        await expect(findInput(page, locale)).toBeFocused();
        expect(await historyEntry(page)).toEqual(entry);

        await findPanel(page, locale).getByRole("button", { name: "MCP", exact: true }).click();
        await findPanel(page, locale).getByLabel(findCopy[locale].failures, { exact: true }).click();
        await findPanel(page, locale).getByLabel(findCopy[locale].work, { exact: true }).click();
        await expect.poll(() => state.searches.at(-1)?.request).toMatchObject({ q: privateQuery, types: ["mcp"], failures_only: true, work_only: true });
        await expect(result(page, locale, callMatchLabel)).toBeVisible();
        await expect(result(page, locale, oldMatchLabel)).toHaveCount(0);
        await assertNoAutomaticSearch(page, state, locale);
        await privateStateAbsent(page); await observe(page, "filtered-and-stale");

        await findInput(page, locale).focus();
        await findInput(page, locale).press("Escape");
        await expect(findInput(page, locale)).toHaveValue("");
        await findInput(page, locale).press("Escape");
        await expect(findInput(page, locale)).toHaveCount(0);
        await expect(page.getByRole("button", { name: findCopy[locale].title, exact: true })).toBeFocused();
        await expect(page.getByRole("button", { name: findCopy[locale].back, exact: true })).toBeVisible();
        await touchTargets(page, locale);
        const searchesBeforeReturn = state.searches.length;
        await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: width === 390 ? 1000 : 844 });
        await observe(page, "closed-and-resized");
        if (width !== 390) await page.getByRole("tab", { name: catalogs[locale].sessions.detail.tabs.details, exact: true }).click();
        const related = page.getByRole("link", { name: originalNoteTitle, exact: true });
        await expect(related).toHaveAttribute("href", noteHref);
        await related.click();
        await expect(page.getByRole("dialog", { name: catalogs[locale].notes.editTitle, exact: true })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const restoreStart = state.requests.length;
        await page.getByRole("button", { name: findCopy[locale].back, exact: true }).click();
        await expect(selected.getByRole("checkbox")).toBeChecked();
        await expect(selected).toBeFocused();
        await expect.poll(async () => Math.abs(await selected.evaluate((element) => element.getBoundingClientRect().top) - originalTop)).toBeLessThanOrEqual(8);
        await settled(state);
        expect(windowRequests(state, restoreStart).some((request) => request.mode === "refresh" && request.cursor === "window:9902:10001")).toBe(true);
        expect(state.searches).toHaveLength(searchesBeforeReturn);
        expect(await historyEntry(page)).toEqual(entry);
        await assertDraftRetry(page, locale, state, savePayload);
        await privateStateAbsent(page); await observe(page, "original-investigation-restored");
      });

      test("partial, stale, empty, retry and denied searches remain distinct; late results cannot refill", async ({ page }) => {
        const state = await setup(page, locale, width);
        const copy = findCopy[locale];
        state.searchMode = "partial";
        await openFind(page, locale, width === 390);
        await findInput(page, locale).fill(privateQuery);
        await expect(result(page, locale, oldMatchLabel)).toBeVisible();
        await expect(findPanel(page, locale).getByText(copy.partial)).toBeVisible();
        await expect(findPanel(page, locale).getByText(copy.pending).first()).toBeVisible();
        expect(privateBodyReads(state)).toHaveLength(0);
        await observe(page, "partial-coverage");
        await touchTargets(page, locale);
        state.continueStatus = 409;
        await findPanel(page, locale).getByRole("button", { name: copy.continue, exact: true }).click();
        await expect(findPanel(page, locale).getByText(copy.stale)).toBeVisible();
        await expect(result(page, locale, oldMatchLabel)).toBeVisible();
        expect(state.searches.at(-1)!.request.cursor).toBe("synthetic-search-cursor-7");

        state.searchMode = "pending";
        await findPanel(page, locale).getByRole("button", { name: copy.again, exact: true }).click();
        await expect(result(page, locale, oldMatchLabel)).toHaveCount(0);
        await expect(findPanel(page, locale).getByText(copy.pending).first()).toBeVisible();
        const pendingCopy = await findPanel(page, locale).innerText();
        await expect(findPanel(page, locale).getByRole("button", { name: copy.continue, exact: true })).toHaveCount(0);
        state.searchMode = "empty";
        await findInput(page, locale).fill(`${privateQuery}absent`);
        await expect(findPanel(page, locale).getByText(copy.empty)).toBeVisible();
        expect(await findPanel(page, locale).innerText()).not.toBe(pendingCopy);

        state.searchStatus = 503;
        const retryQuery = privateQuery;
        await findInput(page, locale).fill(retryQuery);
        const retry = findPanel(page, locale).getByRole("button", { name: catalogs[locale].sessions.contents.retry, exact: true });
        await expect(retry).toBeVisible();
        await touchTargets(page, locale);
        await expect(findInput(page, locale)).toHaveValue(retryQuery);
        await expect(findPanel(page, locale).getByText(copy.empty)).toHaveCount(0);
        state.searchStatus = 200; state.searchMode = "complete";
        await retry.click();
        await expect(result(page, locale, oldMatchLabel)).toBeVisible();
        await expect(findInput(page, locale)).toHaveValue(retryQuery);

        state.holdSearch = true;
        await findInput(page, locale).fill(privateQuery.toUpperCase());
        await expect.poll(() => state.heldSearch.length).toBe(1);
        const readsBeforeDenial = privateBodyReads(state).length;
        state.holdSearch = false; state.searchStatus = 403;
        await findInput(page, locale).fill(privateQuery.toLowerCase());
        await expect(page.getByRole("heading", { name: catalogs[locale].sessions.detail.accessLost.title, exact: true })).toBeVisible();
        state.releaseSearch();
        await settled(state);
        await expect(findInput(page, locale)).toHaveCount(0);
        await expect(page.getByText(oldMatchLabel, { exact: false })).toHaveCount(0);
        await expect(page.getByText(callMatchLabel, { exact: false })).toHaveCount(0);
        expect(privateBodyReads(state)).toHaveLength(readsBeforeDenial);
        await privateStateAbsent(page); await observe(page, "denied-late-response-purged");
      });
    });
  }
}

test("source disappearance preserves the draft; presenter mode hides snippets and a cold reload forgets the query", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  const reader = await openTranscript(page, "en");
  await prepareHandoff(page, "en", reader);
  const initialPayload = handoffRequests(state)[0]!.payload!;
  await openFind(page, "en", false);
  await findInput(page, "en").fill(privateQuery);
  await expect(result(page, "en", oldMatchLabel)).toBeVisible();
  await page.getByRole("button", { name: en.sessions.hidePrompts.label, exact: true }).click();
  expect(await findPanel(page, "en").ariaSnapshot()).not.toContain(oldMatchLabel);
  expect(await findPanel(page, "en").ariaSnapshot()).not.toContain(callMatchLabel);
  const hidden = findPanel(page, "en").locator("[data-prompt-hidden] [aria-hidden]");
  expect(await hidden.count()).toBeGreaterThanOrEqual(2);
  expect(await hidden.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).userSelect === "none"))).toBe(true);
  await page.getByRole("button", { name: en.sessions.hidePrompts.label, exact: true }).click();
  state.sourceStatus = 404;
  const authorityBefore = state.requests.filter((request) => request.path === sessionPath).length;
  await result(page, "en", oldMatchLabel).click();
  await expect(page.getByText(findCopy.en.unavailable).first()).toBeVisible();
  await expect.poll(() => state.requests.filter((request) => request.path === sessionPath).length).toBeGreaterThan(authorityBefore);
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await assertDraftRetry(page, "en", state, initialPayload);
  state.sourceStatus = 200;
  await privateStateAbsent(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await openFind(page, "en", false);
  await expect(findInput(page, "en")).toHaveValue("");
  await expect(result(page, "en", oldMatchLabel)).toHaveCount(0);
  await privateStateAbsent(page);
});

test("an empty scan page permits one bounded continuation without a background scan loop", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  state.searchMode = "sparse";
  await openFind(page, "en", false);
  await findInput(page, "en").fill(privateQuery);
  const more = findPanel(page, "en").getByRole("button", { name: findCopy.en.continue, exact: true });
  await expect(more).toBeVisible();
  await settled(state); expect(state.searches).toHaveLength(1);
  await page.waitForTimeout(500); expect(state.searches).toHaveLength(1);
  state.searchMode = "complete";
  await more.click();
  await expect(result(page, "en", oldMatchLabel)).toBeVisible();
  await settled(state); expect(state.searches).toHaveLength(2);
  expect(state.searches[1]!.request.cursor).toBe("synthetic-search-cursor-7");
  expect(privateBodyReads(state)).toHaveLength(0);
  expect(state.requests.filter((request) => request.path === searchPath).every((request) => !request.query)).toBe(true);
});

test("Return restores an expanded grouped body after its window changed; an existing hash never overrides Find", async ({ page }) => {
  const state = await setup(page, "en", 1440, `${routePath}#content-${groupedOriginId}`);
  const origin = page.locator(`#content-${groupedOriginId}`);
  await expect(origin).toBeFocused();
  await origin.getByRole("button", { name: /^Show all/ }).click();
  await origin.getByRole("button", { name: /^Load more/ }).click();
  await expect(origin).toContainText(groupedLaterLabel);
  const sourceBlock = origin.locator("pre");
  await sourceBlock.hover();
  await page.mouse.wheel(0, await sourceBlock.evaluate((element) => element.scrollHeight));
  await expect.poll(() => sourceBlock.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await transcript(page, "en").getByRole("combobox", { name: en.sessions.contents.navigation.label, exact: true }).selectOption(groupedOriginId);
  await expect(origin).toBeFocused();
  const before = await historyEntry(page), top = await origin.evaluate((element) => element.getBoundingClientRect().top);
  const innerTop = await sourceBlock.evaluate((element) => element.scrollTop);
  await openFind(page, "en", false);
  await findInput(page, "en").fill(privateQuery);
  await result(page, "en", oldMatchLabel).click();
  await expect(page.locator(`#content-${oldContentId} mark`)).toHaveText(privateQuery);
  await expect(origin).toHaveCount(0);
  expect(await historyEntry(page)).toEqual(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(result(page, "en", oldMatchLabel)).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  state.staleRestore = true;
  const restoreStart = state.requests.length;
  await page.getByRole("button", { name: findCopy.en.back, exact: true }).click();
  await expect.poll(() => windowRequests(state, restoreStart).some((request) => request.status === 409)).toBe(true);
  await settled(state);
  expect(windowRequests(state, restoreStart).some((request) => request.mode === "anchor" || request.mode === "latest")).toBe(false);
  await expect(page.getByRole("button", { name: findCopy.en.back, exact: true })).toBeVisible();
  await page.getByRole("button", { name: findCopy.en.returnAnchor, exact: true }).click();
  await expect(origin).toBeFocused();
  await expect(origin).toContainText(groupedLaterLabel);
  await expect(origin.getByRole("button", { name: en.sessions.contents.body.showLess, exact: true })).toBeVisible();
  await expect.poll(async () => Math.abs(await sourceBlock.evaluate((element) => element.scrollTop) - innerTop)).toBeLessThanOrEqual(2);
  await expect.poll(async () => Math.abs(await origin.evaluate((element) => element.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(8);
  await settled(state);
  const restores = windowRequests(state, restoreStart);
  expect(restores.some((request) => request.status === 409 && request.mode === "refresh")).toBe(true);
  expect(restores.some((request) => request.mode === "anchor" && request.query.includes(groupedOriginId))).toBe(true);
  expect(restores.some((request) => request.mode === "latest")).toBe(false);
  expect(await historyEntry(page)).toEqual(before);
  await observe(page, "grouped-later-page-restored");
});

test("an exact event match reveals its highlighted bytes inside a long scrollable field", async ({ page }) => {
  const state = await setup(page, "en", 1440);
  state.callFieldPrefix = Array.from({ length: 150 }, (_, index) => `Earlier retained line ${index + 1}\n`).join("");
  const loadedCallRequests = state.requests.filter((request) => request.path === `${sessionPath}/calls`).length;
  await openFind(page, "en", false);
  await findInput(page, "en").fill(privateQuery);
  const matchedResult = result(page, "en", callMatchLabel);
  await expect(matchedResult).toBeVisible();
  await settled(state);
  expect(privateBodyReads(state)).toHaveLength(0);

  await matchedResult.click();
  const panel = page.getByRole("tabpanel", { name: en.sessions.detail.tabs.timeline, exact: true });
  const mark = panel.locator("pre mark");
  await expect(mark).toHaveText(privateQuery);
  await expect(panel.locator("pre")).toContainText("Earlier retained line 1\n");
  await expect(matchedResult).toBeFocused();
  await settled(state);
  expect(privateBodyReads(state).map((request) => request.path)).toEqual([`${sessionPath}/calls/${callKey}`]);
  expect(state.requests.filter((request) => request.path === `${sessionPath}/calls`)).toHaveLength(loadedCallRequests);
  expect(windowRequests(state)).toHaveLength(0);

  const position = () => mark.evaluate((element) => {
    const source = element.closest("pre")!;
    const matchBounds = element.getBoundingClientRect(), sourceBounds = source.getBoundingClientRect();
    const sourceTop = sourceBounds.top + source.clientTop, sourceBottom = sourceTop + source.clientHeight;
    const nativeScrollRounding = 1;
    return { markTop: matchBounds.top, markBottom: matchBounds.bottom, sourceTop, sourceBottom,
      scrollTop: source.scrollTop, scrollHeight: source.scrollHeight, clientHeight: source.clientHeight,
      visibleWithinSource: matchBounds.top >= sourceTop - nativeScrollRounding && matchBounds.bottom <= sourceBottom + nativeScrollRounding,
      visibleWithinViewport: matchBounds.top >= -nativeScrollRounding && matchBounds.bottom <= innerHeight + nativeScrollRounding };
  });
  const initial = await position();
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  try {
    await expect.poll(async () => {
      const measured = await position();
      return measured.visibleWithinSource && measured.visibleWithinViewport;
    }, { timeout: 3_000, message: "Activating a deep field match must scroll its actual marked bytes into view" }).toBe(true);
  } finally {
    runs.get(page)!.observations.push({ phase: "long-event-field-match", initial, final: await position() });
    await page.screenshot({ path: test.info().outputPath("long-event-field-match.png") });
  }
  await expect(matchedResult).toBeFocused();
});
