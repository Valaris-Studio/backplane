// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardId, cardId, contentId, contentsPath, routePath, session, sessionPath, sha, slug, windowRequests } from "./fixtures/session-window-fixture";
import { noteHref, noteId, notePath, originalNoteTitle, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { cardApi, cardHref, cardSummary, cardTitle, folderId, historyHref, historyQuery, installA04Fixture,
  privateBodyReads, relatedReads, resourceApi, resourceBody, resourceHref, resourceId, resourceSummary, resourceTitle,
  unexpectedConsole, workspaceApi, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
// Keep the repository's normal 90s case / 15s expectation deadlines and zero retries.
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const inputPaths = ["e2e/a04-related-continuity.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts",
  "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/providers/NavigationGuardProvider.tsx", "src/components/shared/ContextLink.tsx", "src/pages/Dashboard.tsx", "src/pages/WorkspaceHistoryPage.tsx",
  "src/features/activity/components/ActivityTimeline.tsx", "src/features/kanban/components/CardDetailSheet.tsx",
  "src/features/kanban/components/BoardView.tsx", "src/features/notes/components/NoteEditor.tsx", "src/features/notes/components/NoteEditorMeta.tsx",
  "src/features/sessions/components/LinkedSessionsSection.tsx", "src/features/sessions/components/SessionDetailPage.tsx",
  "src/features/sessions/components/SessionTimeline.tsx", "src/features/sessions/components/SessionTranscript.tsx",
  "src/features/sessions/components/SessionRail.tsx", "src/features/sessions/components/ExcerptNoteDialog.tsx",
  "src/features/resources/components/ResourceList.tsx"];
const hashFiles = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
type Run = { state: A04Fixture; locale: Locale; width: number; inputBefore: ReturnType<typeof hashFiles>;
  sourceBefore: ReturnType<typeof hashFiles>; observations: unknown[]; secondary: { page: Page; state: A04Fixture }[] };
const runs = new Map<Page, Run>();
const path = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };
const entry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx }));
const noteEditor = (page: Page, locale: Locale) => page.getByRole("dialog", { name: catalogs[locale].notes.editTitle, exact: true });
const cardEditor = (page: Page, locale: Locale) => page.getByRole("dialog", { name: catalogs[locale].cards.editTitle, exact: true });
const relatedSection = (page: Page, locale: Locale, kind: "card" | "note") => page.getByRole("region", {
  name: kind === "card" ? catalogs[locale].sessions.linked.cardTitle : catalogs[locale].sessions.linked.noteTitle, exact: true,
});
const activate = async (control: Locator, method: "keyboard" | "touch" = "keyboard") => {
  if (method === "touch") await control.tap();
  else { await control.focus(); await control.press("Enter"); }
};
const mutations = (state: A04Fixture) => state.requests.filter((request) => !["GET", "HEAD"].includes(request.method));
async function settled(state: A04Fixture) { await expect.poll(() => state.inflight).toBe(0); expect(state.unexpected).toEqual([]); }

async function setup(page: Page, locale: Locale, width: number, start: string, kind: "card" | "note" = "card", configure?: (state: A04Fixture) => void) {
  expect(manifest, "Root must bind this run to the exact preserved dist manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const state = await installA04Fixture(page, locale);
  state.sourceKind = kind;
  configure?.(state);
  runs.set(page, { state, locale, width, inputBefore: hashFiles(inputPaths), sourceBefore: hashFiles(sourcePaths), observations: [], secondary: [] });
  await page.goto(start);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  return state;
}

async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  const view = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { href: location.href, historyState: history.state, focus: active ? { id: active.id, tag: active.tagName, text: active.textContent?.slice(0, 150) } : null,
      viewport: { width: innerWidth, height: innerHeight }, touchPoints: navigator.maxTouchPoints,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      scroll: [document.scrollingElement, ...document.querySelectorAll<HTMLElement>("main *, [role=dialog] *")]
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element.scrollTop > 0)
        .map((element) => ({ tag: element.tagName, id: element.id, top: element.scrollTop, height: element.clientHeight })) };
  });
  run.observations.push({ name, ...view, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect(view.reducedMotion).toBe(true);
  expect(view.horizontalOverflow).toBeLessThanOrEqual(1);
  return view;
}

async function jump(page: Page, locale: Locale, kind: "card" | "note", method: "keyboard" | "touch" = "keyboard") {
  const label = kind === "card" ? catalogs[locale].sessions.linked.cardTitle : catalogs[locale].sessions.linked.noteTitle;
  const editor = kind === "card" ? cardEditor(page, locale) : noteEditor(page, locale);
  const beforeURL = path(page), beforeEntry = await entry(page);
  await activate(editor.getByRole("button", { name: label, exact: true }), method);
  const section = relatedSection(page, locale, kind);
  await expect(section).toHaveCount(1);
  await expect(section.getByRole("heading", { name: label, exact: true })).toBeFocused();
  expect(path(page)).toBe(beforeURL); expect(await entry(page)).toEqual(beforeEntry);
  await expect(page.getByRole("alertdialog", { name: catalogs[locale].unsavedChanges.title, exact: true })).toHaveCount(0);
  return section;
}

async function assertInspect(page: Page, locale: Locale, title: string, relation: "changed" | "consulted") {
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  const heading = catalogs[locale].sessions.evidence.title.replace("{{title}}", title);
  const section = page.getByRole("region", { name: heading, exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: heading, exact: true })).toBeFocused();
  await expect(section.getByText(catalogs[locale].sessions.work[relation], { exact: true })).toBeVisible();
  await expect(section.locator("[data-call-row]")).toHaveCount(1);
  // The fixture deliberately lists consulted first. Changed must still win;
  // note-only consulted must select its own call rather than the whole timeline.
  await expect(section.locator("[data-call-name]")).toHaveText(relation === "changed" ? "backplane · update_card" : "backplane · get_note");
  expect(path(page)).toBe(routePath);
  await assertPrivateContextAbsent(page, [title, relation]);
}

async function assertPrivateContextAbsent(page: Page, workValues: string[] = []) {
  const context = await page.evaluate(() => ({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  const exposed = JSON.stringify(context);
  for (const text of [privateDraftTitle, privateDraftBody, "entity_id", "selectedWork", "handoff"])
    expect(exposed).not.toContain(text);
  const privateWork = [cardId, noteId, cardTitle, originalNoteTitle, "changed", "consulted", ...workValues];
  const retained = JSON.stringify({ history: context.history, local: context.local, session: context.session });
  for (const value of privateWork) {
    expect(retained).not.toContain(value);
    // A work identity may legitimately be in its own canonical entity URL.
    if (new URL(context.href).pathname === routePath) expect(decodeURIComponent(context.href)).not.toContain(value);
  }
}

async function transcript(page: Page, locale: Locale) {
  await activate(page.getByRole("tab", { name: catalogs[locale].sessions.detail.tabs.transcript, exact: true }));
  const reader = page.getByRole("region", { name: catalogs[locale].sessions.contents.title, exact: true });
  await expect(reader).toBeVisible(); return reader;
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const states = [run.state, ...run.secondary.map((item) => item.state)];
  states.forEach((state) => { state.releaseRelated(); state.release(); });
  let screenshotError: string | null = null, drainError: string | null = null;
  if (!page.isClosed()) {
    try { await page.screenshot({ path: info.outputPath("final-shell.png") }); }
    catch (error) { screenshotError = String(error); }
  }
  const sealObservation = (complete: boolean) => states.map((state) => {
    state.observationCutoff = Date.now();
    return { complete, cutoffAt: state.observationCutoff, fixtureInflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()].map((request) => ({ ...request })),
      pendingProofs: state.pendingProofs, proofsStarted: state.proofsStarted,
      heldRequests: state.held.length + state.heldRelated.length };
  });
  let completion: ReturnType<typeof sealObservation> | null = null;
  try {
    await expect.poll(() => {
      // Route fulfillment can finish before the browser emits response/finished.
      if (states.some((state) => state.inflight || state.pendingBrowserRequests.size || state.pendingProofs
        || state.held.length || state.heldRelated.length)) return false;
      completion = sealObservation(true);
      return true;
    }).toBe(true);
  } catch (error) { drainError = String(error); }
  const completed = completion ?? sealObservation(false);
  const inputAfter = hashFiles(inputPaths), sourceAfter = hashFiles(sourcePaths);
  const assets = states.flatMap((state, pageIndex) => state.builtAssets.map((asset) => ({ ...asset, pageIndex, expected: manifest?.files[asset.manifestKey] ?? null })));
  const pageCoverage = states.map((state) => {
    const observed = state.builtAssets.filter((asset) => !asset.afterCutoff);
    return { html: observed.filter((asset) => asset.manifestKey === "index.html").length,
      js: observed.filter((asset) => /\.js$/.test(asset.manifestKey)).length,
      css: observed.filter((asset) => /\.css$/.test(asset.manifestKey)).length };
  });
  const receipt = info.outputPath("a04-related-ledger.json");
  writeFileSync(receipt, JSON.stringify({
    scope: "Preserved built AppShell; synthetic HTTP/WebSocket only. No deployed authorization, persistence or A08 acceptance claim.",
    status: info.status, baseURL: process.env.BACKPLANE_E2E_BASE_URL, browser: page.context().browser()?.version(),
    locale: run.locale, viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    inputsBefore: run.inputBefore, inputsAfter: inputAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
    observations: run.observations, assets, screenshotError, drainError,
    observationScope: "Completion covers each explicit cutoff only. Later observed events are marked; attachment, page closure and later runner teardown are outside that cutoff.",
    pages: states.map((state, pageIndex) => ({ completion: completed[pageIndex], assetCoverage: pageCoverage[pageIndex],
      browserRequests: state.browserRequests, afterCutoffEvents: state.afterCutoffEvents,
      requests: state.requests, responses: state.responseReceipts, sockets: state.socketLedger,
      unexpected: state.unexpected, failures: state.failures, console: state.consoleReceipts, unexpectedConsole: unexpectedConsole(state), noteWrites: state.noteWrites })),
  }, null, 2));
  await info.attach("a04-related-ledger", { path: receipt, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(inputAfter).toEqual(run.inputBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
  for (const coverage of pageCoverage) {
    expect.soft(coverage.html).toBeGreaterThan(0); expect.soft(coverage.js).toBeGreaterThan(0); expect.soft(coverage.css).toBeGreaterThan(0);
  }
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  for (const state of states) {
    expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
    expect.soft(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED")
      || ![contentsPath, `${sessionPath}/calls`, `${sessionPath}/links`, notePath, cardApi, "/api/me/sessions"]
        .some((prefix) => failure.startsWith(prefix)))).toEqual([]);
  }
  for (const secondary of run.secondary) await secondary.page.close();
  runs.delete(page);
});

test("EN desktop: Dashboard filter → card jump → changed Inspect → contextual Return → native Back", async ({ page }) => {
  const state = await setup(page, "en", 1440, `/${slug}`);
  const chip = page.getByTestId("activity-type-chip-card");
  await activate(chip); await expect(chip).toHaveAttribute("aria-pressed", "true");
  const origin = page.getByRole("link", { name: cardSummary, exact: true });
  await expect(origin).toHaveAttribute("href", cardHref);
  await expect(page.getByRole("link", { name: resourceSummary, exact: true })).toHaveCount(0);
  await settled(state); expect(privateBodyReads(state)).toEqual([]);
  await activate(origin); await expect(cardEditor(page, "en").getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(cardTitle);
  await settled(state); expect(relatedReads(state)).toEqual([]);
  const section = await jump(page, "en", "card");
  const linked = section.getByRole("link", { name: session.title!, exact: true });
  await expect(linked).toHaveAttribute("href", routePath);
  await activate(linked); await assertInspect(page, "en", cardTitle, "changed");
  expect(privateBodyReads(state)).toEqual([]); expect(mutations(state)).toEqual([]);
  await observe(page, "en-desktop-changed-inspect");
  await activate(page.getByRole("link", { name: en.navigation.returnToPrevious, exact: true }));
  await expect(linked).toBeFocused(); await expect(section).toHaveCount(1);
  await observe(page, "en-desktop-card-return");
  await page.goBack(); await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(origin).toBeFocused(); await expect.poll(() => path(page)).toBe(`/${slug}`);
  await observe(page, "en-desktop-dashboard-return");
});

test.describe("ES narrow native touch", () => {
  test.use({ hasTouch: true });
  test("dirty note jump is local; Cancel, Save and Discard govern only the related-session departure", async ({ page }) => {
    const state = await setup(page, "es", 390, noteHref, "note");
    const editor = noteEditor(page, "es"), title = editor.getByRole("textbox", { name: es.cards.titleLabel, exact: true });
    const draft = "SYNTHETIC NOTE DRAFT EXPLICITLY SAVED";
    await expect(title).toHaveValue(originalNoteTitle);
    const originalContent = state.note.content;
    await title.fill(draft);
    const reloadWarning = page.waitForEvent("dialog");
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    const warning = await reloadWarning; expect(warning.type()).toBe("beforeunload"); await warning.dismiss();
    await expect(title).toHaveValue(draft);
    const section = await jump(page, "es", "note", "touch");
    await expect(title).toHaveValue(draft); expect(state.noteWrites).toEqual([]);
    const linked = section.getByRole("link", { name: session.title!, exact: true });
    await expect(linked).toHaveAttribute("href", routePath);
    const prompt = page.getByRole("alertdialog", { name: es.unsavedChanges.title, exact: true });
    await linked.tap(); await expect(prompt).toBeVisible();
    await observe(page, "es-touch-before-note-consent");
    await prompt.getByRole("button", { name: es.unsavedChanges.keepEditing, exact: true }).tap();
    await expect(title).toHaveValue(draft); expect(path(page)).toBe(noteHref); expect(state.noteWrites).toEqual([]);
    await linked.tap(); await prompt.getByRole("button", { name: es.unsavedChanges.save, exact: true }).tap();
    await assertInspect(page, "es", draft, "consulted");
    expect(state.noteWrites).toHaveLength(1); expect(state.noteWrites[0]?.title).toBe(draft);
    expect(state.noteWrites[0]?.content).toBe(originalContent);
    await page.getByRole("link", { name: es.navigation.returnToPrevious, exact: true }).tap();
    await expect(linked).toBeFocused(); await expect(section).toHaveCount(1); await expect(title).toHaveValue(draft);
    await title.fill("SYNTHETIC NOTE DRAFT EXPLICITLY DISCARDED");
    await linked.tap(); await prompt.getByRole("button", { name: es.unsavedChanges.discard, exact: true }).tap();
    await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
    await page.goBack(); await expect(title).toHaveValue(draft); await expect(linked).toBeFocused();
    expect(state.noteWrites).toHaveLength(1); expect(privateBodyReads(state)).toEqual([]);
    const observation = await observe(page, "es-touch-note-return"); expect(observation.touchPoints).toBeGreaterThan(0);
  });

  test("explicit related section keeps loading, transient error/retry and empty answers visible", async ({ page }) => {
    const state = await setup(page, "es", 390, noteHref, "note", (fixture) => {
      fixture.holdRelated = true; fixture.relatedStatus = 503;
    });
    await expect(noteEditor(page, "es").getByRole("textbox", { name: es.cards.titleLabel, exact: true })).toHaveValue(originalNoteTitle);
    const section = await jump(page, "es", "note", "touch");
    await expect.poll(() => state.heldRelated.length).toBe(1);
    await expect(section.getByRole("status")).toHaveText(es.common.loading);
    await observe(page, "es-touch-requested-loading");
    state.releaseRelated(); await expect(section.getByText(es.sessions.linked.loadError, { exact: true })).toBeVisible();
    state.relatedStatus = 200; state.relatedEmpty = true;
    await section.getByRole("button", { name: es.sessions.loadError.retry, exact: true }).tap();
    await expect(section.getByText(es.sessions.linked.noneNote, { exact: true })).toBeVisible();
    await expect(section.getByRole("link", { name: session.title!, exact: true })).toHaveCount(0);
    expect(privateBodyReads(state)).toEqual([]); expect(mutations(state)).toEqual([]);
    await observe(page, "es-touch-requested-empty");
  });
});

test("PT-BR narrow keyboard: earlier Transcript selection and reviewed unknown-outcome handoff survive work-link Back", async ({ page }) => {
  const state = await setup(page, "pt-BR", 390, routePath, "note"), t = pt;
  const reader = await transcript(page, "pt-BR");
  await activate(reader.getByRole("button", { name: t.sessions.contents.filters.everything, exact: true }));
  await activate(reader.getByRole("button", { name: t.sessions.contents.window.beginning, exact: true }));
  await expect(page.locator(`#content-${contentId(1)}`)).toBeAttached();
  await activate(reader.getByRole("button", { name: t.sessions.contents.window.later, exact: true }));
  const selected = page.locator(`#content-${contentId(152)}`);
  await reader.getByRole("combobox", { name: t.sessions.contents.navigation.label, exact: true }).selectOption(contentId(152));
  await expect(selected).toBeFocused(); await selected.getByRole("checkbox").press("Space");
  await expect(selected.getByRole("checkbox")).toBeChecked();
  await activate(reader.getByRole("button", { name: t.sessions.contents.excerpt.preview, exact: true }));
  const preview = page.getByRole("dialog", { name: t.sessions.contents.excerpt.title, exact: true });
  await expect(preview.getByRole("textbox", { name: t.sessions.contents.excerpt.previewLabel, exact: true })).toHaveValue(/SYNTHETIC COMPLETE RECORD 152/);
  const labels = t.sessions.contents.excerpt.note;
  await activate(preview.getByRole("button", { name: labels.share, exact: true }));
  const dialog = page.getByRole("dialog", { name: labels.share, exact: true });
  await dialog.getByRole("combobox", { name: labels.workspace, exact: true }).selectOption(slug);
  await dialog.getByRole("combobox", { name: labels.board, exact: true }).selectOption(boardId);
  await dialog.getByRole("textbox", { name: labels.title, exact: true }).fill(privateDraftTitle);
  await dialog.locator("[contenteditable='true']").fill(privateDraftBody);
  await activate(dialog.getByRole("button", { name: labels.save, exact: true }));
  await expect(dialog.getByRole("alert")).toHaveText(labels.unknown);
  const firstSave = state.requests.find((request) => request.method === "POST" && request.path.endsWith("/notes/from-excerpt"))!;
  expect(JSON.parse(firstSave.payload!).excerpt_source.items).toHaveLength(1);
  await activate(dialog.getByRole("button", { name: labels.hide, exact: true }));
  await assertPrivateContextAbsent(page);
  await activate(page.getByRole("tab", { name: t.sessions.detail.tabs.details, exact: true }));
  const workLink = page.getByRole("link", { name: originalNoteTitle, exact: true });
  await expect(workLink).toHaveAttribute("href", noteHref);
  await workLink.focus(); const top = (await workLink.boundingBox())!.y;
  await workLink.press("Enter"); await expect(noteEditor(page, "pt-BR")).toBeVisible();
  const returnStart = state.requests.length;
  await page.goBack(); await expect(workLink).toBeFocused();
  await expect.poll(async () => Math.abs((await workLink.boundingBox())!.y - top)).toBeLessThanOrEqual(8);
  const returned = await transcript(page, "pt-BR");
  await expect(page.locator(`#content-${contentId(101)}`)).toBeAttached();
  await expect(page.locator(`#content-${contentId(200)}`)).toBeAttached();
  await expect(page.locator(`#content-${contentId(9902)}`)).toHaveCount(0);
  await expect(selected.getByRole("checkbox")).toBeChecked();
  await settled(state);
  expect(windowRequests(state, returnStart).some((request) => request.mode === "refresh" && request.cursor === "window:101:200")).toBe(true);
  await activate(returned.getByRole("button", { name: labels.resume, exact: true }));
  await expect(dialog.getByRole("textbox", { name: labels.title, exact: true })).toHaveValue(privateDraftTitle);
  await expect(dialog.getByRole("region", { name: labels.content, exact: true })).toContainText(privateDraftBody);
  await activate(dialog.getByRole("button", { name: labels.retry, exact: true }));
  await expect(dialog.getByRole("alert")).toHaveText(labels.unknown);
  const saves = state.requests.filter((request) => request.method === "POST" && request.path.endsWith("/notes/from-excerpt"));
  expect(saves).toHaveLength(2); expect(saves[1]?.payload).toBe(firstSave.payload); expect(state.noteWrites).toEqual([]);
  await assertPrivateContextAbsent(page); await observe(page, "pt-keyboard-restored-handoff");
});

test("EN History search → null-title summary → exact nested resource outside root list → native Back", async ({ page }) => {
  const state = await setup(page, "en", 1440, historyHref);
  const search = page.getByPlaceholder(en.activity.searchPlaceholder, { exact: true });
  await search.fill(historyQuery);
  await expect.poll(() => state.requests.some((request) => request.path === `${workspaceApi}/history`
    && new URLSearchParams(request.query).get("search") === historyQuery)).toBe(true);
  const link = page.getByRole("link", { name: resourceSummary, exact: true });
  await expect(link).toHaveAttribute("href", resourceHref);
  await settled(state); expect(state.requests.filter((request) => request.path.startsWith(resourceApi))).toEqual([]);
  await activate(link);
  const preview = page.getByRole("dialog", { name: resourceTitle, exact: true });
  await expect(preview.locator("pre")).toHaveText(resourceBody);
  expect(state.requests.some((request) => request.path === `${resourceApi}/${resourceId}` && request.status === 200)).toBe(true);
  const initialList = state.requests.find((request) => request.path === resourceApi)!;
  expect(initialList.ids).not.toContain(resourceId);
  await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe(folderId);
  await expect(page.getByRole("navigation", { name: en.resources.folderPath }).getByRole("button", { name: "Nested", exact: true })).toBeVisible();
  expect(privateBodyReads(state)).toEqual([]); expect(mutations(state)).toEqual([]);
  await observe(page, "en-history-exact-nested-resource");
  await page.goBack(); await expect(search).toHaveValue(historyQuery); await expect(link).toBeFocused();
  await expect.poll(() => path(page)).toBe(historyHref);
  expect(new URL(page.url()).search).toBe("");
  await observe(page, "en-history-search-return");
});

test("EN source access loss while private preview is held cannot revive labels or bytes after reconnect", async ({ page }) => {
  const state = await setup(page, "en", 1440, noteHref, "note");
  await expect(noteEditor(page, "en").getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(originalNoteTitle);
  const section = await jump(page, "en", "note");
  await activate(section.getByRole("link", { name: session.title!, exact: true }));
  await assertInspect(page, "en", originalNoteTitle, "consulted");
  expect(privateBodyReads(state)).toEqual([]);
  const reader = await transcript(page, "en"), row = page.locator(`#content-${contentId(9950)}`);
  await row.locator("label").click(); state.holdBody = true;
  await activate(reader.getByRole("button", { name: en.sessions.contents.excerpt.preview, exact: true }));
  await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  state.authorityStatus = 403; state.ownerBurst(1);
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: en.sessions.detail.loadError.title, exact: true })).toBeVisible();
  state.release(); await settled(state);
  const bodiesAfterLoss = privateBodyReads(state).length, beforeReconnect = state.socketsOpened;
  const deniedReads = state.requests.filter((request) => request.path === sessionPath && request.status === 403).length;
  await state.disconnect(); await expect.poll(() => state.socketsOpened).toBeGreaterThan(beforeReconnect);
  await expect.poll(() => state.subscriptions.length).toBeGreaterThan(0); state.ownerBurst(1);
  await expect.poll(() => state.requests.filter((request) => request.path === sessionPath && request.status === 403).length).toBeGreaterThan(deniedReads);
  await settled(state);
  await expect(page.getByText(/SYNTHETIC COMPLETE RECORD/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(privateBodyReads(state)).toHaveLength(bodiesAfterLoss);
  await assertPrivateContextAbsent(page); await observe(page, "en-denied-late-response-reconnected");
});

test("PT-BR narrow keyboard: copied canonical URL and reload omit private Inspect handoff", async ({ page }) => {
  const state = await setup(page, "pt-BR", 390, noteHref, "note");
  await expect(noteEditor(page, "pt-BR").getByRole("textbox", { name: pt.cards.titleLabel, exact: true })).toHaveValue(originalNoteTitle);
  const section = await jump(page, "pt-BR", "note");
  const link = section.getByRole("link", { name: session.title!, exact: true });
  const href = await link.getAttribute("href"); expect(href).toBe(routePath);
  await activate(link); await assertInspect(page, "pt-BR", originalNoteTitle, "consulted");
  const history = await page.evaluate(() => JSON.stringify(window.history.state));
  expect(history).not.toContain(noteId); expect(history).not.toContain(cardId); expect(history).not.toContain("consulted");
  const copy = await page.context().newPage(); await copy.setViewportSize({ width: 390, height: 844 });
  const copiedState = await installA04Fixture(copy, "pt-BR"); copiedState.sourceKind = "note";
  runs.get(page)!.secondary.push({ page: copy, state: copiedState });
  await copy.goto(href!);
  await expect(copy.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await expect(copy.getByRole("heading", { name: pt.sessions.timeline.title, exact: true })).toBeVisible();
  await expect(copy.getByRole("button", { name: pt.sessions.evidence.return, exact: true })).toHaveCount(0);
  await assertPrivateContextAbsent(copy);
  await copy.screenshot({ path: test.info().outputPath("pt-copied-canonical-url.png") });
  await page.reload();
  await expect(page.getByRole("heading", { name: pt.sessions.timeline.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: pt.sessions.evidence.return, exact: true })).toHaveCount(0);
  expect(path(page)).toBe(routePath); await assertPrivateContextAbsent(page);
  expect(privateBodyReads(state)).toEqual([]); expect(privateBodyReads(copiedState)).toEqual([]);
  await observe(page, "pt-reloaded-no-inspect-handoff");
});
