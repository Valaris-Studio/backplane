// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { privateBodyReads, unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";
import { cardLinkLabel, firstCardId, installSectionReturnFixture, secondCardId, sectionCardApi,
  sectionCardHref, sectionCardTitle } from "./fixtures/a04-section-return.review";
import { sha } from "./fixtures/session-window-fixture";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce", serviceWorkers: "block" });
// Preserve the repository's 90s case / 15s assertion deadlines and zero retries.
const inputPaths = ["e2e/a04-section-return.review.spec.ts", "e2e/fixtures/a04-section-return.review.ts",
  "e2e/fixtures/a04-related-continuity.ts", "e2e/fixtures/uxc-navigation-fixture.ts",
  "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx",
  "src/providers/NavigationGuardProvider.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/features/sessions/components/LinkedSessionsSection.tsx", "src/features/sessions/hooks/use-in-view.ts",
  "src/features/sessions/api/use-linked-sessions.ts", "src/features/kanban/components/BoardView.tsx",
  "src/features/kanban/components/CardDetailSheet.tsx", "src/features/kanban/api/use-card-detail.ts",
  "src/components/shared/RichTextEditor.tsx", "src/components/shared/RichTextEditorImpl.tsx",
  "src/components/ui/sheet.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
type Run = { state: A04Fixture; statusA: 200 | 403; beforeInputs: ReturnType<typeof hashes>;
  beforeSource: ReturnType<typeof hashes>; observations: unknown[] };
const runs = new Map<Page, Run>();
const editor = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true });
const section = (page: Page) => page.getByRole("region", { name: en.sessions.linked.cardTitle, exact: true });
const entry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx }));
const currentHref = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };
const otherCard = (id: string) => id === firstCardId ? secondCardId : firstCardId;
const relatedRequests = (state: A04Fixture) => state.requests.filter((request) =>
  [firstCardId, secondCardId].some((id) => request.path === sectionCardApi(id) + "/sessions"));
async function settled(state: A04Fixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
  expect(state.requests.filter((request) => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  expect(privateBodyReads(state)).toEqual([]);
}
async function ready(page: Page, state: A04Fixture, id: string) {
  await expect.poll(() => currentHref(page)).toBe(sectionCardHref(id));
  await expect(editor(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(sectionCardTitle(id));
  // A real lazy editor has its own readiness boundary, independent of the
  // title field and HTTP completion. The action uses its actual rendered link.
  await expect(editor(page).getByRole("link", { name: cardLinkLabel(otherCard(id)), exact: true }))
    .toHaveAttribute("href", sectionCardHref(otherCard(id)));
  await expect(editor(page).getByRole("button", { name: en.common.save, exact: true })).toBeDisabled();
  await settled(state);
  expect(state.requests.some((request) => request.path === sectionCardApi(id) && request.status === 200)).toBe(true);
}
async function requestSection(page: Page, state: A04Fixture, id: string, copy: string) {
  const beforeURL = currentHref(page), beforeEntry = await entry(page);
  await editor(page).getByRole("button", { name: en.sessions.linked.cardTitle, exact: true }).click();
  await expect(section(page)).toHaveCount(1);
  await expect(section(page).getByRole("heading", { name: en.sessions.linked.cardTitle, exact: true })).toBeFocused();
  await expect(section(page).getByText(copy, { exact: true })).toBeVisible();
  expect(currentHref(page)).toBe(beforeURL); expect(await entry(page)).toEqual(beforeEntry);
  await settled(state);
  expect(relatedRequests(state).some((request) => request.path === sectionCardApi(id) + "/sessions")).toBe(true);
}
async function followCard(page: Page, state: A04Fixture, id: string) {
  const link = editor(page).getByRole("link", { name: cardLinkLabel(id), exact: true });
  await expect(link).toHaveAttribute("href", sectionCardHref(id));
  // Real pointer dispatch, TipTap and CardDetailSheet's capture handler;
  // no DOM insertion, synthetic router navigation or private state injection.
  await link.click();
  await ready(page, state, id);
  await expect(page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true })).toHaveCount(0);
}
async function observe(page: Page, phase: string) {
  const run = runs.get(page)!;
  const view = await page.evaluate(() => {
    const active = document.activeElement;
    return { at: Date.now(), href: location.href, historyState: history.state,
      focus: active ? { tag: active.tagName, id: active.id, text: active.textContent?.slice(0, 120) } : null,
      viewport: { width: innerWidth, height: innerHeight }, touchPoints: navigator.maxTouchPoints,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      scrollers: Array.from(document.querySelectorAll<HTMLElement>("[role=dialog], [role=dialog] *"))
        .filter((element) => element.scrollTop > 0)
        .map((element) => ({ tag: element.tagName, id: element.id, top: element.scrollTop, height: element.clientHeight })),
    };
  });
  run.observations.push({ phase, ...view, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(phase + ".png") });
  expect(view.reducedMotion).toBe(true); expect(view.horizontalOverflow).toBeLessThanOrEqual(1);
}
async function privateStateAbsent(page: Page) {
  const value = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const text of ["linked-sessions-opening", sectionCardTitle(firstCardId), sectionCardTitle(secondCardId),
    "Synthetic saved card context", "Synthetic current related-session access denied"]) expect(value).not.toContain(text);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state } = run;
  state.releaseRelated(); state.release();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  const seal = (complete: boolean) => {
    state.observationCutoff = Date.now();
    return { complete, at: state.observationCutoff, inflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()], pendingProofs: state.pendingProofs,
      proofsStarted: state.proofsStarted, heldRequests: state.held.length + state.heldRelated.length };
  };
  let completion: ReturnType<typeof seal> | null = null;
  try {
    await expect.poll(() => {
      if (state.inflight || state.pendingBrowserRequests.size || state.pendingProofs || state.held.length || state.heldRelated.length) return false;
      completion = seal(true); return true;
    }).toBe(true);
  } catch (error) { drainError = String(error); }
  const cutoff = completion ?? seal(false);
  const afterInputs = hashes(inputPaths), afterSource = hashes(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const observed = assets.filter((asset) => !asset.afterCutoff);
  const coverage = { html: observed.filter((asset) => asset.manifestKey === "index.html").length,
    js: observed.filter((asset) => /\.js$/.test(asset.manifestKey)).length,
    css: observed.filter((asset) => /\.css$/.test(asset.manifestKey)).length };
  const receipt = info.outputPath("a04-section-return-ledger.json");
  writeFileSync(receipt, JSON.stringify({
    scope: "Actual preserved AppShell; two synthetic exact cards and current empty/denied related-session HTTP. No live authorization or A08/release acceptance.",
    regressionOrigin: { sourceHead: "2f917c8ba75a3617f2920c38381566b9768e2dff", sourceTree: "631c3ce928e488fc98b94636f7e076b387d599fb",
      sourceTestSha256: "6b5ee55239cdc17bb11e510dd9138707a4dd675a8247ee410c56ad9833749471",
      rootOriginalResult: "2 FAIL / 1 PASS, 5.45s, no unhandled errors; browser outcome not inferred" },
    status: info.status, statusA: run.statusA, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: "en", viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, currentSourceBefore: run.beforeSource, currentSourceAfter: afterSource,
    observations: run.observations, assets, assetCoverage: coverage, screenshotError, drainError, cutoff,
    observationLimit: "The explicit completion cutoff excludes later attachment, page closure and runner teardown; later observed events are marked separately.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests, sockets: state.socketLedger,
    failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-section-return-ledger", { path: receipt, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  for (const count of Object.values(coverage)) expect.soft(count).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  const permittedAbortPaths = new Set([sectionCardApi(firstCardId), sectionCardApi(secondCardId), "/api/me/sessions"]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith(" net::ERR_ABORTED")
    || !permittedAbortPaths.has(failure.slice(0, -" net::ERR_ABORTED".length)))).toEqual([]);
  runs.delete(page);
});

for (const statusA of [200, 403] as const) {
  test("A04 N4 HTTP" + statusA + ": mounted card Return keeps its requested explanation and fresh entries remain quiet", async ({ page }) => {
    expect(manifest, "Root must bind this run to the exact preserved build manifest").not.toBeNull();
    const state = await installSectionReturnFixture(page, statusA);
    runs.set(page, { state, statusA, beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
    await page.goto(sectionCardHref(firstCardId));
    await expect(page.getByRole("banner")).toBeVisible(); await expect(page.getByRole("main")).toBeVisible();
    await ready(page, state, firstCardId);
    await expect(section(page)).toHaveCount(0);
    const expectedA = statusA === 403 ? en.sessions.discovery.accessLost : en.sessions.linked.noneCard;
    await requestSection(page, state, firstCardId, expectedA);
    const originEntry = await entry(page), sheetHandle = await editor(page).elementHandle();
    await observe(page, "a-requested");
    await followCard(page, state, secondCardId);
    await expect(section(page)).toHaveCount(0);
    await requestSection(page, state, secondCardId, en.sessions.linked.noneCard);
    const bEntry = await entry(page), bSentinel = await section(page).locator("..").elementHandle();
    expect(bEntry.key).not.toBe(originEntry.key);
    await observe(page, "b-requested");
    await page.goBack();
    await expect.poll(() => entry(page)).toEqual(originEntry);
    await ready(page, state, firstCardId);
    const survival = await page.evaluate(({ sheet, sentinel }) => ({ sheetConnected: sheet?.isConnected ?? false,
      sentinelConnected: sentinel?.isConnected ?? false }), { sheet: sheetHandle, sentinel: bSentinel });
    runs.get(page)!.observations.push({ phase: "back-mounted-dom-observation", ...survival });
    // Still a mandatory failing assertion. Soft collection lets this same
    // baseline continue to the independent fresh-entry isolation control.
    await expect.soft(section(page).getByText(expectedA, { exact: true }),
      "Back must restore A's requested current explanation").toBeVisible();
    expect.soft(await section(page).count()).toBe(1);
    await observe(page, "back-a-explanation");
    await page.goForward();
    await expect.poll(() => entry(page)).toEqual(bEntry);
    await ready(page, state, secondCardId);
    await expect(section(page).getByText(en.sessions.linked.noneCard, { exact: true })).toBeVisible();
    await followCard(page, state, firstCardId);
    const freshA = await entry(page);
    expect(freshA.key).not.toBe(originEntry.key); expect(freshA.key).not.toBe(bEntry.key);
    await settled(state);
    await expect(section(page)).toHaveCount(0);
    await privateStateAbsent(page); await observe(page, "fresh-a-quiet");
    await page.goBack();
    await expect.poll(() => entry(page)).toEqual(bEntry);
    await ready(page, state, secondCardId);
    await expect(section(page)).toHaveCount(1);
    await expect(section(page).getByText(en.sessions.linked.noneCard, { exact: true })).toBeVisible();
    await privateStateAbsent(page); await settled(state); await observe(page, "back-b-requested");
    await sheetHandle?.dispose(); await bSentinel?.dispose();
  });
}
