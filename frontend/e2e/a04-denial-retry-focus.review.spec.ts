// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { routePath, session, sessionPath, sha } from "./fixtures/session-window-fixture";
import { notePath, originalNoteTitle, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { installA04Fixture, privateBodyReads, unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce", serviceWorkers: "block" });
// Use the repository's unchanged 90s case / 15s expectation deadlines.
const inputPaths = ["e2e/a04-denial-retry-focus.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/features/sessions/components/SessionStates.tsx",
  "src/features/sessions/components/SessionDetailPage.tsx", "src/features/sessions/api/use-sessions.ts",
  "src/features/sessions/hooks/use-session-crumb.ts", "src/components/layout/EmptyState.tsx", "src/components/ui/button.tsx",
  "src/providers/ReturnNavigationProvider.tsx", "src/providers/NavigationGuardProvider.tsx", "src/lib/query-keys.ts"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
type Attempt = { path: string; query: string; method: string; startedAt: number; releasedAt?: number;
  fallbackStartedAt?: number; fallbackCompletedAt?: number; error?: string };

async function installRetryGate(page: Page) {
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const attempts: Attempt[] = [], held = new Map<Attempt, () => void>();
  let armed = false, released = false, active = 0;
  // Only the deliberate retry is held. Fallback preserves the existing exact
  // route's credential, method, response and accounting boundaries.
  await page.route((url) => url.origin === origin && url.pathname === sessionPath, async (route) => {
    if (!armed) return route.fallback();
    const request = route.request(), url = new URL(request.url());
    const attempt: Attempt = { path: url.pathname, query: url.search, method: request.method(), startedAt: Date.now() };
    attempts.push(attempt); active += 1;
    try {
      if (!released) await new Promise<void>((resolve) => held.set(attempt, () => {
        attempt.releasedAt = Date.now(); held.delete(attempt); resolve();
      }));
      else attempt.releasedAt = Date.now();
      attempt.fallbackStartedAt = Date.now();
      await route.fallback();
      attempt.fallbackCompletedAt = Date.now();
    } catch (error) {
      attempt.error = String(error);
      throw error;
    } finally { active -= 1; }
  });
  return { attempts, held, get active() { return active; }, arm() { armed = true; }, release() {
    released = true;
    for (const release of held.values()) release();
  } };
}

type Run = { state: A04Fixture; gate: Awaited<ReturnType<typeof installRetryGate>>;
  beforeInputs: ReturnType<typeof hashes>; beforeSource: ReturnType<typeof hashes>; observations: unknown[] };
const runs = new Map<Page, Run>();

async function tabTo(page: Page, target: Locator) {
  // Finite native traversal, not focus injection or a timing retry.
  for (let step = 0; step < 32; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function observe(page: Page, retry: Locator, name: string) {
  const run = runs.get(page)!;
  const focus = await retry.evaluate((element) => {
    const active = document.activeElement as HTMLElement | null;
    const button = element as HTMLButtonElement;
    return { ownsFocus: active === element, connected: element.isConnected, disabled: button.disabled,
      ariaDisabled: element.getAttribute("aria-disabled"), ariaBusy: element.getAttribute("aria-busy"),
      active: active ? { tag: active.tagName, id: active.id, text: active.textContent?.slice(0, 160) } : null,
      href: location.href, historyState: history.state, at: performance.now() };
  });
  run.observations.push({ name, ...focus, attempts: run.gate.attempts.length,
    held: run.gate.held.size, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function expectPrivateDataAbsent(page: Page, state: A04Fixture) {
  await expect(page.getByText(session.title!, { exact: true })).toHaveCount(0);
  await expect(page.getByText(originalNoteTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/SYNTHETIC (COMPLETE RECORD|PREVIEW)/)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(privateBodyReads(state)).toEqual([]);
  expect(state.requests.filter((request) => request.path.startsWith(`${sessionPath}/`) || request.path === notePath)).toEqual([]);
  expect(state.requests.filter((request) => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  expect(state.noteWrites).toEqual([]);
  const exposed = await page.evaluate(() => ({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [session.title!, originalNoteTitle, privateDraftTitle, privateDraftBody, "selectedWork", "excerpt_source"])
    expect(JSON.stringify(exposed)).not.toContain(value);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state, gate } = run;
  gate.release(); state.release(); state.releaseRelated();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  try {
    await expect.poll(() => gate.active + gate.held.size + state.inflight + state.pendingBrowserRequests.size
      + state.pendingProofs + state.held.length + state.heldRelated.length).toBe(0);
  } catch (error) { drainError = String(error); }
  state.observationCutoff = Date.now();
  const afterInputs = hashes(inputPaths), afterSource = hashes(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const receiptPath = info.outputPath("a04-denial-retry-focus-ledger.json");
  writeFileSync(receiptPath, JSON.stringify({
    scope: "Actual built AppShell; initial and repeated synthetic owner-session HTTP403. Native keyboard/DOM focus, not jsdom or live authorization proof.",
    status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: "en", viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, beforeSource: run.beforeSource, afterSource,
    attempts: gate.attempts, observations: run.observations, assets, screenshotError, drainError,
    cutoff: { at: state.observationCutoff, complete: drainError === null, gateActive: gate.active,
      gateHeld: gate.held.size, inflight: state.inflight, pendingRequests: [...state.pendingBrowserRequests.values()],
      pendingProofs: state.pendingProofs, heldRequests: state.held.length + state.heldRelated.length },
    observationLimit: "The cutoff excludes later attachment/page closure/runner teardown; observed later events are marked. No capture forces focus or scrolling.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests,
    sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-denial-retry-focus-ledger", { path: receiptPath, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  for (const suffix of ["index.html", ".js", ".css"])
    expect.soft(assets.some((asset) => asset.manifestKey.endsWith(suffix))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  expect.soft(state.failures).toEqual([]);
  runs.delete(page);
});

test("A04 neutral owner denial Retry keeps keyboard focus through one held and repeated403 response", async ({ page }) => {
  expect(manifest, "Root must bind this run to the actual preserved dist manifest").not.toBeNull();
  const state = await installA04Fixture(page, "en"); state.authorityStatus = 403;
  const gate = await installRetryGate(page);
  runs.set(page, { state, gate, beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  await page.goto(routePath);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("heading", { name: en.sessions.detail.loadError.title, exact: true })).toBeVisible();
  const retry = page.getByRole("main").getByRole("button", { name: en.sessions.loadError.retry, exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByText(en.sessions.loadError.accessDenied, { exact: true })).toBeVisible();
  await expect(page.getByText(en.sessions.loadError.agentKey, { exact: true })).toHaveCount(0);
  await expect.poll(() => state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  expect(state.requests.filter((request) => request.path === sessionPath)).toHaveLength(1);
  await expectPrivateDataAbsent(page, state);
  await tabTo(page, retry); await expect(retry).toBeFocused();
  await observe(page, retry, "initial-denial-keyboard-focus");
  gate.arm();
  await page.keyboard.press("Enter");
  await expect.poll(() => gate.held.size).toBe(1);
  expect(gate.attempts).toHaveLength(1);
  expect(gate.attempts[0]).toMatchObject({ method: "GET", path: sessionPath, query: "" });
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await expect.soft(retry, "A held authorization retry must keep its keyboard focus owner").toBeFocused();
  await observe(page, retry, "retry-held-focus");
  await expect(page.getByText(en.sessions.loadError.accessDenied, { exact: true })).toBeVisible();
  await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  expect(gate.attempts).toHaveLength(1);
  expect(state.browserRequests.filter((request) => request.path === sessionPath)).toHaveLength(2);
  await expectPrivateDataAbsent(page, state);
  gate.release();
  await expect.poll(() => state.responseReceipts.filter((response) => response.path === sessionPath && response.status === 403).length).toBe(2);
  await expect(retry).toBeEnabled();
  await expect.soft(retry, "A repeated denial must retain Retry focus without test-driver assistance").toBeFocused();
  await observe(page, retry, "repeated-denial-focus");
  await expect(page.getByText(en.sessions.loadError.accessDenied, { exact: true })).toBeVisible();
  await expect(page.getByText(en.sessions.loadError.agentKey, { exact: true })).toHaveCount(0);
  await expect.poll(() => gate.active + state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  expect(gate.attempts).toHaveLength(1);
  expect(state.requests.filter((request) => request.path === sessionPath)).toHaveLength(2);
  await expectPrivateDataAbsent(page, state);
});
