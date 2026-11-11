// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type ElementHandle, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { contentsPath, sessionPath, sha, slug } from "./fixtures/session-window-fixture";
import { noteHref, notePath, originalNoteTitle } from "./fixtures/uxc-navigation-fixture";
import { cardApi, cardHref, cardSummary, cardTitle, installA04Fixture, privateBodyReads, relatedReads,
  unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
// The unchanged repository configuration supplies 90s cases / 15s expectations.
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
type Kind = "card" | "note";
const inputPaths = ["e2e/a04-related-retry-focus.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts",
  "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/pages/Dashboard.tsx", "src/features/activity/components/ActivityTimeline.tsx",
  "src/features/kanban/components/BoardView.tsx", "src/features/kanban/components/CardDetailSheet.tsx",
  "src/features/notes/components/NoteEditor.tsx", "src/features/notes/components/NoteEditorMeta.tsx",
  "src/features/sessions/components/LinkedSessionsSection.tsx", "src/features/sessions/api/use-linked-sessions.ts",
  "src/components/ui/button.tsx", "src/components/ui/sheet.tsx", "src/components/ui/editor-sheet.tsx",
  "src/hooks/use-focus-trap.ts", "src/lib/query-keys.ts", "src/providers/ReturnNavigationProvider.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;

type Run = { state: A04Fixture; locale: Locale; kind: Kind; beforeInputs: ReturnType<typeof hashes>;
  beforeSource: ReturnType<typeof hashes>; observations: unknown[] };
const runs = new Map<Page, Run>();
const path = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };
const entry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx }));
const mutations = (state: A04Fixture) => state.requests.filter((request) => !["GET", "HEAD"].includes(request.method));
const listPath = (kind: Kind) => kind === "card" ? `${cardApi}/sessions` : `${notePath}/sessions`;
const editorFor = (page: Page, locale: Locale, kind: Kind) => page.getByRole("dialog", {
  name: kind === "card" ? catalogs[locale].cards.editTitle : catalogs[locale].notes.editTitle, exact: true,
});
function labelsFor(locale: Locale, kind: Kind) {
  const linked = catalogs[locale].sessions.linked;
  return { section: kind === "card" ? linked.cardTitle : linked.noteTitle, loadError: linked.loadError,
    empty: kind === "card" ? linked.noneCard : linked.noneNote, retry: catalogs[locale].sessions.loadError.retry,
    accessLost: catalogs[locale].sessions.discovery.accessLost,
    privacy: kind === "card" ? linked.privacyCard : linked.privacyNote };
}
type Labels = ReturnType<typeof labelsFor>;
async function settled(state: A04Fixture) { await expect.poll(() => state.inflight).toBe(0); expect(state.unexpected).toEqual([]); }

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 64; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return step;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  return 64;
}

async function retrySnapshot(page: Page, original: ElementHandle<HTMLElement | SVGElement>, text: Labels) {
  // Reading the document rather than awaiting a locator keeps an unmounted
  // Retry observable; no DOM, provider or cache state is written by this probe.
  return page.evaluate(({ original, text }) => {
    const section = [...document.querySelectorAll<HTMLElement>("section[aria-labelledby]")].find((candidate) =>
      document.getElementById(candidate.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === text.section) ?? null;
    const current = section ? [...section.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === text.retry) ?? null : null;
    const active = document.activeElement as HTMLElement | null;
    return { sectionPresent: section !== null, originalConnected: original.isConnected, sameNode: current !== null && current === original,
      originalFocused: active === original, errorCopyInSection: section?.textContent?.includes(text.loadError) ?? false,
      loadingInSection: !!section?.querySelector('[role="status"]'),
      disabled: original instanceof HTMLButtonElement ? original.disabled : null,
      ariaBusy: original.getAttribute("aria-busy"), ariaDisabled: original.getAttribute("aria-disabled"),
      active: active ? { tag: active.tagName, id: active.id, text: active.textContent?.slice(0, 160) ?? "" } : null,
      href: location.href, historyLength: history.length, at: performance.now() };
  }, { original, text });
}

async function observe(page: Page, original: ElementHandle<HTMLElement | SVGElement>, text: Labels, name: string) {
  const run = runs.get(page)!;
  const snapshot = await retrySnapshot(page, original, text);
  run.observations.push({ name, ...snapshot, relatedReads: relatedReads(run.state).length,
    heldRelated: run.state.heldRelated.length, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return snapshot;
}

async function keyboardJump(page: Page, locale: Locale, kind: Kind, text: Labels) {
  const control = editorFor(page, locale, kind).getByRole("button", { name: text.section, exact: true });
  await control.focus(); await control.press("Enter");
  const section = page.getByRole("region", { name: text.section, exact: true });
  await expect(section).toHaveCount(1);
  await expect(section.getByRole("heading", { name: text.section, exact: true })).toBeFocused();
  return section;
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state } = run;
  state.releaseRelated(); state.release();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  try {
    await expect.poll(() => state.inflight + state.pendingBrowserRequests.size + state.pendingProofs
      + state.held.length + state.heldRelated.length).toBe(0);
  } catch (error) { drainError = String(error); }
  state.observationCutoff = Date.now();
  const afterInputs = hashes(inputPaths), afterSource = hashes(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const receiptPath = info.outputPath("a04-related-retry-focus-ledger.json");
  writeFileSync(receiptPath, JSON.stringify({
    scope: "Actual built AppShell related-sessions section; synthetic first-load 503, one held keyboard retry, repeated 503, then empty 200 or neutral denial. No injected cache/provider state or live authorization claim.",
    status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: run.locale, kind: run.kind, viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, beforeSource: run.beforeSource, afterSource,
    observations: run.observations, assets, screenshotError, drainError,
    cutoff: { at: state.observationCutoff, complete: drainError === null, inflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()], pendingProofs: state.pendingProofs,
      heldRequests: state.held.length + state.heldRelated.length },
    observationLimit: "The cutoff excludes later attachment/page closure/runner teardown. Observed later events are marked. No screenshot forces focus or scrolling.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests,
    sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-related-retry-focus-ledger", { path: receiptPath, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  for (const suffix of ["index.html", ".js", ".css"])
    expect.soft(assets.some((asset) => asset.manifestKey.endsWith(suffix))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED")
    || ![contentsPath, `${sessionPath}/calls`, `${sessionPath}/links`, notePath, cardApi, "/api/me/sessions"]
      .some((prefix) => failure.startsWith(prefix)))).toEqual([]);
  runs.delete(page);
});

async function heldRetryJourney(page: Page, locale: Locale, kind: Kind, width: number, outcome: 200 | 403 = 200) {
  expect(manifest, "Root must bind this run to the exact preserved dist manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const state = await installA04Fixture(page, locale);
  state.sourceKind = kind; state.relatedStatus = 503;
  runs.set(page, { state, locale, kind, beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  const text = labelsFor(locale, kind), related = listPath(kind), editor = editorFor(page, locale, kind);
  const title = editor.getByRole("textbox", { name: catalogs[locale].cards.titleLabel, exact: true });
  if (kind === "card") {
    await page.goto(`/${slug}`);
    await expect(page.getByRole("banner")).toBeVisible(); await expect(page.getByRole("main")).toBeVisible();
    const origin = page.getByRole("link", { name: cardSummary, exact: true });
    await expect(origin).toHaveAttribute("href", cardHref);
    await settled(state);
    await origin.focus(); await origin.press("Enter");
    await expect(title).toHaveValue(cardTitle);
    await expect.poll(() => path(page)).toBe(cardHref);
    await settled(state); expect(relatedReads(state)).toEqual([]);
  } else {
    await page.goto(noteHref);
    await expect(page.getByRole("banner")).toBeVisible(); await expect(page.getByRole("main")).toBeVisible();
    await expect(title).toHaveValue(originalNoteTitle);
    await settled(state);
    // At 390×844 the note's lazy section can start in view and load once by
    // visibility before any jump (first run: one 503). Only that read may
    // precede the jump, which then reuses its first-load answer without a read.
    const visibleLoad = relatedReads(state);
    runs.get(page)!.observations.push({ name: "note-pre-jump-visible-load", reads: visibleLoad.length });
    expect(visibleLoad.length).toBeLessThanOrEqual(1);
    for (const read of visibleLoad) expect(read).toMatchObject({ method: "GET", path: related, query: "", status: 503 });
  }
  const beforePath = path(page), beforeEntry = await entry(page);

  const section = await keyboardJump(page, locale, kind, text);
  const retry = section.getByRole("button", { name: text.retry, exact: true });
  await expect(section.getByText(text.loadError, { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(retry).not.toHaveAttribute("aria-busy", "true");
  await expect(section.getByText(text.accessLost, { exact: true })).toHaveCount(0);
  await settled(state);
  expect(relatedReads(state).map(({ status }) => status)).toEqual([503]);
  const tabSteps = await tabTo(page, retry); await expect(retry).toBeFocused();
  const original = await retry.elementHandle(); expect(original).not.toBeNull();
  runs.get(page)!.observations.push({ name: "native-tab-steps-from-heading", tabSteps });
  await observe(page, original!, text, `${locale}-${kind}-retry-before`);

  state.holdRelated = true;
  await page.context().setOffline(true);
  await page.keyboard.press("Enter");
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(retry).toBeFocused();
  await expect(retry).not.toHaveAttribute("disabled");
  expect(relatedReads(state)).toHaveLength(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(relatedReads(state)).toHaveLength(1);
  await observe(page, original!, text, `${locale}-${kind}-retry-offline`);
  await page.context().setOffline(false);
  await expect.poll(() => state.heldRelated.length).toBe(1);
  expect(relatedReads(state)).toHaveLength(2);
  // Wait for an observable held-retry render before judging focus. The defect
  // unmounts Retry; a repair exposes busy semantics on the same node. A
  // pre-commit focused node must not give a false PASS.
  await expect.poll(async () => {
    const current = await retrySnapshot(page, original!, text);
    return !current.originalConnected || current.disabled === true || current.ariaBusy === "true" || current.ariaDisabled === "true";
  }).toBe(true);
  const held = await observe(page, original!, text, `${locale}-${kind}-retry-held`);
  expect.soft(held.sectionPresent, "The related section stays mounted while the retry is held").toBe(true);
  expect.soft(held.errorCopyInSection, "The error row stays in its section while the retry is held").toBe(true);
  expect.soft(held.sameNode, "The same Retry node stays in its error row while held").toBe(true);
  expect.soft(held.originalFocused, "The same Retry node keeps document.activeElement while held").toBe(true);
  expect.soft(held.ariaBusy, "Held Retry exposes aria-busy").toBe("true");
  expect.soft(held.ariaDisabled, "Held Retry exposes aria-disabled").toBe("true");
  expect.soft(held.disabled, "Held Retry is never natively disabled").toBe(false);
  await expect.soft(retry, "Retry keeps native keyboard focus while the request is held").toBeFocused();
  await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  expect(relatedReads(state)).toHaveLength(2); expect(state.heldRelated).toHaveLength(1);

  state.releaseRelated();
  await expect.poll(() => state.responseReceipts.filter((response) => response.path === related && response.status === 503).length).toBe(2);
  await settled(state);
  expect(relatedReads(state).map(({ status }) => status)).toEqual([503, 503]);
  await expect(section.getByText(text.loadError, { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(retry).not.toHaveAttribute("aria-busy", "true");
  await expect(retry).not.toHaveAttribute("aria-disabled", "true");
  await expect(section.getByText(text.accessLost, { exact: true })).toHaveCount(0);
  const repeated = await observe(page, original!, text, `${locale}-${kind}-repeated-503`);
  expect.soft(repeated.sameNode, "A repeated 503 keeps the same Retry node").toBe(true);
  expect.soft(repeated.originalFocused, "A repeated 503 keeps focus on the same Retry node").toBe(true);
  await expect.soft(retry, "A repeated 503 must retain Retry focus without test-driver assistance").toBeFocused();

  state.relatedStatus = outcome; state.relatedEmpty = true;
  await page.keyboard.press("Enter");
  await expect(section.getByText(outcome === 200 ? text.empty : text.accessLost, { exact: true })).toBeVisible();
  if (outcome === 200) await expect(section.getByRole("heading", { name: text.section, exact: true })).toBeFocused();
  else await expect(retry).toBeFocused();
  await settled(state);
  await expect(section.getByText(text.loadError, { exact: true })).toHaveCount(0);
  if (outcome === 200) await expect(retry).toHaveCount(0);
  expect(relatedReads(state).map(({ status }) => status)).toEqual([503, 503, outcome]);
  expect(new Set(relatedReads(state).map(({ query }) => query)).size).toBe(1);
  expect(state.browserRequests.filter((request) => request.path === related).map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
  expect(privateBodyReads(state)).toEqual([]); expect(mutations(state)).toEqual([]); expect(state.noteWrites).toEqual([]);
  expect(path(page)).toBe(beforePath); expect(await entry(page)).toEqual(beforeEntry);
  await observe(page, original!, text, `${locale}-${kind}-${outcome === 200 ? "recovered-empty" : "neutral-denial"}`);
  if (outcome === 403) {
    state.holdRelated = true;
    await page.keyboard.press("Enter");
    await expect.poll(() => state.heldRelated.length).toBe(1);
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await expect(section.getByText(text.accessLost, { exact: true })).toBeVisible();
    await expect(section.getByText(text.loadError, { exact: true })).toHaveCount(0);
    await expect(section.getByText(text.privacy, { exact: true })).toHaveCount(0);
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    expect(relatedReads(state)).toHaveLength(4);
    const deniedHeld = await observe(page, original!, text, `${locale}-${kind}-denial-retry-held`);
    expect(deniedHeld.sameNode).toBe(true);
    state.releaseRelated();
    await settled(state);
    await expect(retry).toBeFocused();
    await expect(retry).not.toHaveAttribute("aria-busy", "true");
    await expect(section.getByText(text.accessLost, { exact: true })).toBeVisible();
    await expect(section.getByText(text.privacy, { exact: true })).toHaveCount(0);
    expect(relatedReads(state).map(({ status }) => status)).toEqual([503, 503, 403, 403]);
    expect(privateBodyReads(state)).toEqual([]); expect(mutations(state)).toEqual([]);
    expect(path(page)).toBe(beforePath); expect(await entry(page)).toEqual(beforeEntry);
    await observe(page, original!, text, `${locale}-${kind}-denial-retry-settled`);
  }
}

test("A04 PT-BR desktop card: keyboard jump, Tab and held Retry keep focus through a repeated 503", async ({ page }) => {
  await heldRetryJourney(page, "pt-BR", "card", 1440);
});

test("A04 ES narrow note: keyboard jump, Tab and held Retry keep focus through a repeated 503", async ({ page }) => {
  await heldRetryJourney(page, "es", "note", 390);
});

test("A08 EN desktop card: Retry preserves neutral denial and keyboard focus while held", async ({ page }) => {
  await heldRetryJourney(page, "en", "card", 1440, 403);
});
