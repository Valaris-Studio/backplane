// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardId, contentId, contentsPath, routePath, sessionPath, sha, slug, windowRequests } from "./fixtures/session-window-fixture";
import { noteHref, notePath, originalNoteTitle, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { cardApi, installA04Fixture, unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 },
  reducedMotion: "reduce", serviceWorkers: "block" });
// Uses the repository's 90s case / 15s expectation budgets and zero retries.
const labels = pt.sessions.contents.excerpt.note;
const inputPaths = ["e2e/a04-handoff-geometry.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/pt-BR.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/components/ui/dialog.tsx", "src/hooks/use-focus-trap.ts",
  "src/features/sessions/components/ExcerptNoteDialog.tsx", "src/features/sessions/components/SessionExcerpt.tsx",
  "src/features/sessions/components/SessionTranscript.tsx", "src/features/sessions/components/SessionDetailPage.tsx",
  "src/features/sessions/components/SessionRail.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/providers/ReturnNavigationProvider.tsx", "src/providers/NavigationGuardProvider.tsx", "src/components/shared/ContextLink.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
type Run = { state: A04Fixture; beforeInputs: ReturnType<typeof hashes>; beforeSource: ReturnType<typeof hashes>; observations: unknown[] };
const runs = new Map<Page, Run>();
const activate = async (control: Locator) => { await control.focus(); await control.press("Enter"); };
const publicationRequests = (state: A04Fixture) => state.requests.filter((request) => request.method === "POST" && request.path.endsWith("/notes/from-excerpt"));
const dialogFor = (page: Page) => page.getByRole("dialog", { name: labels.share, exact: true });

async function geometry(page: Page) {
  return dialogFor(page).evaluate((dialog) => {
    const rect = (node: Element | null) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right };
    };
    const style = (node: Element) => {
      const css = getComputedStyle(node);
      return { position: css.position, transform: css.transform, translate: css.translate, overflowX: css.overflowX,
        overflowY: css.overflowY, contain: css.contain, filter: css.filter, perspective: css.perspective };
    };
    const active = document.activeElement;
    const box = dialog.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const ancestors = [];
    for (let node: Element | null = dialog; node && ancestors.length < 8; node = node.parentElement) {
      ancestors.push({ tag: node.tagName, id: node.id, rect: rect(node), style: style(node),
        top: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight });
    }
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, select, input, [contenteditable='true']")).map((node) => ({
      tag: node.tagName, id: node.id, label: node.getAttribute("aria-label") ?? (node.tagName === "BUTTON" ? node.textContent?.trim() : null),
      disabled: "disabled" in node && node.disabled === true, rect: rect(node), focused: node === active,
    }));
    return { href: location.href, historyState: history.state, viewport: { left, top, width, height, scale: viewport?.scale },
      layoutViewport: { width: innerWidth, height: innerHeight }, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      windowScroll: { x: window.scrollX, y: window.scrollY },
      dialog: rect(dialog), heading: rect(dialog.querySelector("h2")), controls, ancestors,
      document: { html: { rect: rect(document.documentElement), style: style(document.documentElement), top: document.documentElement.scrollTop },
        body: { rect: rect(document.body), style: style(document.body), top: document.body.scrollTop } },
      focus: active ? { tag: active.tagName, id: active.id, rect: rect(active), label: active.tagName === "BUTTON" ? active.textContent?.trim() : null } : null,
      focusWithin: dialog.contains(active),
      contained: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.top >= top - 1
        && box.right <= left + width + 1 && box.bottom <= top + height + 1 };
  });
}

async function record(page: Page, name: string) {
  const observation = await geometry(page);
  runs.get(page)!.observations.push({ name, ...observation });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const afterScreenshot = await geometry(page);
  runs.get(page)!.observations.push({ name: `${name}-after-screenshot`, ...afterScreenshot });
  expect.soft([observation.reducedMotion, afterScreenshot.reducedMotion], `${name}: reduced motion remains requested`).toEqual([true, true]);
  // No operator action occurs in this bracket; reduced motion must not leave
  // root scrolling animated behind the open handoff.
  expect.soft(Math.abs(afterScreenshot.windowScroll.x - observation.windowScroll.x),
    `${name}: root horizontal scroll remains still under reduced motion`).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(afterScreenshot.windowScroll.y - observation.windowScroll.y),
    `${name}: root vertical scroll remains still under reduced motion`).toBeLessThanOrEqual(1);
  return observation;
}

async function assertUsableModal(page: Page, phase: string) {
  // No forced scroll/focus before this observation: locator actions would hide
  // the distinction between automatic restoration and test-driver assistance.
  await record(page, `${phase}-before-keyboard`);
  await expect.soft.poll(async () => {
    const current = await geometry(page);
    return { contained: current.contained, focusWithin: current.focusWithin };
  }, `${phase}: the real modal must fit the viewport and own focus`).toEqual({ contained: true, focusWithin: true });
  await record(page, `${phase}-settled`);
}

async function keyboardReach(page: Page, name: string, key: "Tab" | "Shift+Tab") {
  // A frozen handoff has three enabled footer/close buttons. Eight native Tab
  // steps is a bounded control traversal, not a timing retry or synthetic focus.
  for (let step = 0; step < 8; step += 1) {
    const current = await geometry(page);
    runs.get(page)!.observations.push({ name: `keyboard-${name}-${step}`, ...current });
    if (current.focusWithin && current.focus?.label === name) {
      const control = dialogFor(page).getByRole("button", { name, exact: true });
      await expect(control).toBeFocused();
      await expect.soft(control).toBeInViewport({ ratio: 1 });
      return;
    }
    await page.keyboard.press(key);
  }
  await expect(dialogFor(page).getByRole("button", { name, exact: true })).toBeFocused();
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
  const receiptPath = info.outputPath("a04-handoff-geometry-ledger.json");
  writeFileSync(receiptPath, JSON.stringify({
    scope: "Actual preserved AppShell with inherited strict synthetic HTTP/WebSocket; no live authorization or release claim.",
    status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: "pt-BR", manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, beforeSource: run.beforeSource, afterSource,
    observations: run.observations, assets, screenshotError, drainError,
    cutoff: { at: state.observationCutoff, complete: drainError === null, inflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()], pendingProofs: state.pendingProofs,
      held: state.held.length + state.heldRelated.length },
    observationLimit: "The explicit cutoff excludes subsequent page closure and runner teardown; late observed events are marked by the inherited fixture.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests,
    sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-handoff-geometry-ledger", { path: receiptPath, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  for (const suffix of ["index.html", ".js", ".css"]) expect.soft(assets.some((asset) => asset.manifestKey.endsWith(suffix))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED")
    || ![contentsPath, `${sessionPath}/calls`, `${sessionPath}/links`, notePath, cardApi, "/api/me/sessions"]
      .some((prefix) => failure.startsWith(prefix)))).toEqual([]);
  runs.delete(page);
});

test("A04 PT-BR restored handoff remains viewport-contained and keyboard reachable after an unknown retry", async ({ page }) => {
  expect(manifest, "Root must provide the preserved built-asset manifest").not.toBeNull();
  const state = await installA04Fixture(page, "pt-BR"); state.sourceKind = "note";
  runs.set(page, { state, beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  await page.goto(routePath);
  await expect(page.getByRole("banner")).toBeVisible();
  await activate(page.getByRole("tab", { name: pt.sessions.detail.tabs.transcript, exact: true }));
  const reader = page.getByRole("region", { name: pt.sessions.contents.title, exact: true });
  await expect(reader).toBeVisible();
  await activate(reader.getByRole("button", { name: pt.sessions.contents.filters.everything, exact: true }));
  await activate(reader.getByRole("button", { name: pt.sessions.contents.window.beginning, exact: true }));
  await expect(page.locator(`#content-${contentId(1)}`)).toBeAttached();
  await activate(reader.getByRole("button", { name: pt.sessions.contents.window.later, exact: true }));
  const selected = page.locator(`#content-${contentId(152)}`);
  await reader.getByRole("combobox", { name: pt.sessions.contents.navigation.label, exact: true }).selectOption(contentId(152));
  await expect(selected).toBeFocused(); await selected.getByRole("checkbox").press("Space");
  await expect(selected.getByRole("checkbox")).toBeChecked();
  await activate(reader.getByRole("button", { name: pt.sessions.contents.excerpt.preview, exact: true }));
  const preview = page.getByRole("dialog", { name: pt.sessions.contents.excerpt.title, exact: true });
  await expect(preview.getByRole("textbox", { name: pt.sessions.contents.excerpt.previewLabel, exact: true })).toHaveValue(/SYNTHETIC COMPLETE RECORD 152/);
  await activate(preview.getByRole("button", { name: labels.share, exact: true }));
  const dialog = dialogFor(page);
  await dialog.getByRole("combobox", { name: labels.workspace, exact: true }).selectOption(slug);
  await dialog.getByRole("combobox", { name: labels.board, exact: true }).selectOption(boardId);
  await dialog.getByRole("textbox", { name: labels.title, exact: true }).fill(privateDraftTitle);
  await dialog.locator("[contenteditable='true']").fill(privateDraftBody);
  await activate(dialog.getByRole("button", { name: labels.save, exact: true }));
  await expect(dialog.getByRole("alert")).toHaveText(labels.unknown);
  const firstSave = publicationRequests(state)[0]!;
  expect(publicationRequests(state)).toHaveLength(1);
  expect(JSON.parse(firstSave.payload!).excerpt_source.items).toHaveLength(1);
  await record(page, "first-unknown-outcome");
  await activate(dialog.getByRole("button", { name: labels.hide, exact: true }));
  await activate(page.getByRole("tab", { name: pt.sessions.detail.tabs.details, exact: true }));
  const work = page.getByRole("link", { name: originalNoteTitle, exact: true });
  await expect(work).toHaveAttribute("href", noteHref);
  await work.focus(); const originY = (await work.boundingBox())!.y;
  await work.press("Enter");
  await expect(page.getByRole("dialog", { name: pt.notes.editTitle, exact: true })).toBeVisible();
  const returnStart = state.requests.length;
  await page.goBack(); await expect(work).toBeFocused();
  await expect.poll(async () => Math.abs((await work.boundingBox())!.y - originY)).toBeLessThanOrEqual(8);
  // Native input ends Return's focus restoration before leaving the work link.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tab", { name: pt.sessions.detail.tabs.details, exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: pt.sessions.detail.tabs.transcript, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#content-${contentId(101)}`)).toBeAttached();
  await expect(page.locator(`#content-${contentId(200)}`)).toBeAttached();
  await expect(page.locator(`#content-${contentId(9902)}`)).toHaveCount(0);
  await expect(selected.getByRole("checkbox")).toBeChecked();
  await expect(selected).toBeFocused();
  await expect.poll(() => state.inflight).toBe(0);
  expect(windowRequests(state, returnStart).some((request) => request.mode === "refresh" && request.cursor === "window:101:200")).toBe(true);
  await activate(reader.getByRole("button", { name: labels.resume, exact: true }));
  await expect(dialog.getByRole("textbox", { name: labels.title, exact: true })).toHaveValue(privateDraftTitle);
  await expect(dialog.getByRole("region", { name: labels.content, exact: true })).toContainText(privateDraftBody);
  await expect(dialog).toBeVisible();
  await assertUsableModal(page, "restored");
  expect(publicationRequests(state)).toHaveLength(1);
  // Keyboard navigation, never .focus()/.click() on the restored dialog, must
  // expose both the safe dismissal and the deliberate frozen-request retry.
  await keyboardReach(page, labels.hide, "Shift+Tab");
  await keyboardReach(page, labels.retry, "Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => publicationRequests(state).length).toBe(2);
  await expect(dialog.getByRole("alert")).toHaveText(labels.unknown);
  await expect(dialog.getByRole("button", { name: labels.retry, exact: true })).toBeEnabled();
  await assertUsableModal(page, "retry-settled");
  expect(publicationRequests(state)[1]?.payload).toBe(firstSave.payload);
  expect(state.noteWrites).toEqual([]);
  const exposed = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(exposed).not.toContain(privateDraftTitle); expect(exposed).not.toContain(privateDraftBody);
  await keyboardReach(page, labels.hide, "Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(reader.getByRole("button", { name: labels.resume, exact: true })).toBeVisible();
  expect(publicationRequests(state)).toHaveLength(2);
});
