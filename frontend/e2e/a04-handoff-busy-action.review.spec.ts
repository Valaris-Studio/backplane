// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardId, contentId, contentsPath, routePath, session, sessionPath, sha, slug, type RequestReceipt } from "./fixtures/session-window-fixture";
import { notePath, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { cardApi, installA04Fixture, linksFor, unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 },
  reducedMotion: "reduce", serviceWorkers: "block" });
// Keep repository budgets (90s case / 15s expectation), one worker and zero retries.
const labels = pt.sessions.contents.excerpt.note;
const publicationPath = `/api/workspaces/${slug}/boards/${boardId}/notes/from-excerpt`;
const metadataPath = `${contentsPath}/metadata`;
const inputPaths = ["e2e/a04-handoff-busy-action.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/pt-BR.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/components/ui/dialog.tsx", "src/hooks/use-focus-trap.ts",
  "src/features/sessions/components/ExcerptNoteDialog.tsx", "src/features/sessions/components/SessionExcerpt.tsx",
  "src/features/sessions/components/SessionTranscript.tsx", "src/features/sessions/components/SessionDetailPage.tsx",
  "src/features/sessions/api/use-session-realtime.ts", "src/features/sessions/api/use-selected-session-content.ts",
  "src/features/sessions/utils/selected-content.ts",
  "src/features/sessions/hooks/use-handoff-drafts.tsx", "src/providers/ReturnNavigationProvider.tsx",
  "src/providers/NavigationGuardProvider.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
type Phase = "first-save" | "retry";
type Attempt = { phase: Phase; method: string; path: string; payload: string; startedAt: number;
  releasedAt?: number; fallbackStartedAt?: number; fallbackCompletedAt?: number; error?: string };

async function installPublicationGate(page: Page) {
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const attempts: Attempt[] = [];
  const held = new Map<Attempt, () => void>();
  const released = new Set<Phase>();
  let phase: Phase = "first-save", closed = false, active = 0;
  // Registered last, so this observes the request before the existing fixture.
  // It never fulfills or changes it: fallback preserves all inherited checks.
  await page.route((url) => url.origin === origin && url.pathname === publicationPath, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const attempt: Attempt = { phase, method: request.method(), path: new URL(request.url()).pathname,
      payload: request.postData() ?? "", startedAt: Date.now() };
    attempts.push(attempt); active += 1;
    try {
      if (!closed && !released.has(attempt.phase)) {
        await new Promise<void>((resolve) => held.set(attempt, () => {
          attempt.releasedAt = Date.now(); held.delete(attempt); resolve();
        }));
      } else attempt.releasedAt = Date.now();
      attempt.fallbackStartedAt = Date.now();
      await route.fallback();
      attempt.fallbackCompletedAt = Date.now();
    } catch (error) {
      attempt.error = String(error);
      throw error;
    } finally { active -= 1; }
  });
  return { attempts, held, get active() { return active; }, setPhase(next: Phase) { phase = next; },
    releasePhase(target: Phase) {
      released.add(target);
      for (const [attempt, release] of held) if (attempt.phase === target) release();
    },
    releaseAll() {
      // Future arrivals during teardown also fall through instead of hanging.
      closed = true;
      for (const release of held.values()) release();
    },
  };
}

type ValidationAttempt = Omit<Attempt, "phase"> & { phase: "validation" };

async function installValidationGate(page: Page) {
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const attempts: ValidationAttempt[] = [];
  const held = new Map<ValidationAttempt, () => void>();
  let armed = false, closed = false, active = 0;
  // Earlier selection/preview metadata stays untouched. Only the deliberate
  // Save or Recheck arms this hold; fallback preserves the real validator.
  await page.route((url) => url.origin === origin && url.pathname === metadataPath, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !armed || closed) return route.fallback();
    const attempt: ValidationAttempt = { phase: "validation", method: request.method(),
      path: new URL(request.url()).pathname, payload: request.postData() ?? "", startedAt: Date.now() };
    attempts.push(attempt); active += 1;
    try {
      await new Promise<void>((resolve) => held.set(attempt, () => {
        attempt.releasedAt = Date.now(); held.delete(attempt); resolve();
      }));
      attempt.fallbackStartedAt = Date.now();
      await route.fallback();
      attempt.fallbackCompletedAt = Date.now();
    } catch (error) {
      attempt.error = String(error);
      throw error;
    } finally { active -= 1; }
  });
  return { attempts, held, get active() { return active; }, arm() { armed = true; closed = false; },
    releaseAll() {
      closed = true;
      for (const release of held.values()) release();
    },
  };
}

type ValidationBaseline = { browserQueued: number; fixtureDelivered: number };
type HttpFault = { path: string; method: "POST"; mechanism: "inherited metadataStatus override";
  armedAt: number; priorStatus: number; status: 503; body: string };
type Run = { state: A04Fixture; gate: Awaited<ReturnType<typeof installPublicationGate>>;
  validationGate: Awaited<ReturnType<typeof installValidationGate>>; validationBaseline: ValidationBaseline | null;
  beforeInputs: ReturnType<typeof hashes>; beforeSource: ReturnType<typeof hashes>; observations: unknown[];
  httpFaults?: HttpFault[]; liveDetail?: Awaited<ReturnType<typeof installLiveDetailFixture>> };
const runs = new Map<Page, Run>();
const dialogFor = (page: Page) => page.getByRole("dialog", { name: labels.share, exact: true });
const activate = async (control: Locator) => { await control.focus(); await control.press("Enter"); };
const delivered = (state: A04Fixture) => state.requests.filter((request) => request.method === "POST" && request.path === publicationPath);
const deliveredMetadata = (state: A04Fixture) => state.requests.filter((request) => request.method === "POST" && request.path === metadataPath);
const queuedMetadata = (state: A04Fixture) => state.browserRequests.filter((request) => request.method === "POST" && request.path === metadataPath);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Address the user-facing publication action, independent of its busy ARIA API.
const publicationAction = (page: Page) => dialogFor(page).getByRole("button", {
  name: new RegExp(`^(?:${[labels.save, labels.retry, labels.saving].map(escapeRegExp).join("|")})$`),
});

async function observe(page: Page, phase: string) {
  const observation = await dialogFor(page).evaluate((dialog) => {
    const active = document.activeElement;
    return { at: Date.now(), href: location.href, focusWithin: dialog.contains(active),
      focus: active ? { tag: active.tagName, id: active.id, label: active.tagName === "BUTTON" ? active.textContent?.trim() : null } : null,
      buttons: Array.from(dialog.querySelectorAll("button")).map((button) => ({
        label: button.textContent?.trim(), disabled: button.disabled,
        ariaDisabled: button.getAttribute("aria-disabled"), focused: button === active,
      })) };
  });
  runs.get(page)!.observations.push({ phase, ...observation });
  return observation;
}

async function keyboardReach(page: Page, name: string) {
  // Enumerate this real modal's bounded native Tab order; no forced focus.
  for (let step = 0; step < 8; step += 1) {
    const current = await observe(page, `reach-${name}-${step}`);
    if (current.focusWithin && current.focus?.tag === "BUTTON" && current.focus.label === name) {
      await expect(dialogFor(page).getByRole("button", { name, exact: true })).toBeFocused();
      return;
    }
    await page.keyboard.press("Shift+Tab");
  }
  await expect(dialogFor(page).getByRole("button", { name, exact: true })).toBeFocused();
}

async function pointerAttempt(page: Page, phase: string) {
  const action = publicationAction(page);
  await expect(action).toHaveCount(1);
  // Expose the actual disabled-or-busy button for a physical pointer attempt.
  // Scrolling does not focus it; Locator.click would wait for native enabled.
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const viewport = page.viewportSize()!;
  expect(point.x >= 0 && point.x < viewport.width && point.y >= 0 && point.y < viewport.height).toBe(true);
  const hit = await action.evaluate((button, position) => {
    const target = document.elementFromPoint(position.x, position.y);
    return { hitsAction: button.contains(target), nativeDisabled: button instanceof HTMLButtonElement && button.disabled,
      pointerEvents: getComputedStyle(button).pointerEvents, hitTag: target?.tagName ?? null };
  }, point);
  if (!hit.hitsAction) {
    // Native disabled Button deliberately excludes pointer hits. Preserve that
    // control rather than claiming the physical click activates its handler.
    expect(hit.nativeDisabled).toBe(true);
    expect(hit.pointerEvents).toBe("none");
  }
  runs.get(page)!.observations.push({ phase: `${phase}-pointer-attempt`, at: Date.now(), point,
    ...hit, nativePointerBlocked: !hit.hitsAction });
  await page.mouse.click(point.x, point.y);
}

async function assertReviewedDraft(page: Page) {
  await expect(dialogFor(page).getByRole("textbox", { name: labels.title, exact: true })).toHaveValue(privateDraftTitle);
  await expect(dialogFor(page).getByRole("region", { name: labels.content, exact: true })).toContainText(privateDraftBody);
}

async function exerciseHeldValidation(page: Page) {
  const run = runs.get(page)!, { state, gate, validationGate } = run;
  const baseline = run.validationBaseline!;
  await expect.poll(() => validationGate.attempts.length).toBe(1);
  await expect(dialogFor(page).getByRole("status")).toHaveText(pt.sessions.contents.excerpt.validating);
  expect.soft((await observe(page, "validation-pending")).focusWithin,
    "first-save validation: keyboard focus must remain inside while selected metadata is held").toBe(true);
  expect(validationGate.held.size).toBe(1);
  expect(queuedMetadata(state)).toHaveLength(baseline.browserQueued + 1);
  expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered);
  expect([...state.pendingBrowserRequests.values()].filter((request) => request.path === metadataPath)).toHaveLength(1);
  expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect.soft((await observe(page, "validation-after-keyboard-duplicates")).focusWithin,
    "first-save validation: duplicate keyboard attempts must preserve modal focus").toBe(true);
  expect(validationGate.attempts).toHaveLength(1);
  expect(queuedMetadata(state)).toHaveLength(baseline.browserQueued + 1);
  expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered);
  expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
  await assertReviewedDraft(page);
  validationGate.releaseAll();
  await expect.poll(() => validationGate.active).toBe(0);
  await expect.poll(() => deliveredMetadata(state).length).toBe(baseline.fixtureDelivered + 1);
  expect(validationGate.attempts).toHaveLength(1);
}

async function exerciseHeldAttempt(page: Page, phase: Phase, expectedCount: number) {
  const run = runs.get(page)!, { gate, state } = run;
  await expect.poll(() => gate.attempts.length).toBe(expectedCount);
  await expect(dialogFor(page).getByRole("status")).toHaveText(labels.saving);
  // A committed pending status establishes the native disabled/focus seam.
  // Soft failure preserves the baseline while still exercising duplicate guards.
  expect.soft((await observe(page, `${phase}-pending`)).focusWithin,
    `${phase}: keyboard focus must remain inside while the actual POST is held`).toBe(true);
  expect(gate.held.size).toBe(1);
  expect(delivered(state)).toHaveLength(expectedCount - 1);
  expect([...state.pendingBrowserRequests.values()].filter((request) => request.path === publicationPath)).toHaveLength(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await pointerAttempt(page, phase);
  expect(gate.attempts).toHaveLength(expectedCount);
  expect.soft((await observe(page, `${phase}-after-duplicates`)).focusWithin,
    `${phase}: duplicate attempts must not strand keyboard focus`).toBe(true);

  await keyboardReach(page, labels.hide);
  await page.keyboard.press("Enter");
  await expect(dialogFor(page)).toHaveCount(0);
  const resume = page.getByRole("button", { name: labels.resume, exact: true });
  // Resume is a deliberate real pointer action, not a programmatic focus repair.
  await resume.click();
  await expect(dialogFor(page).getByRole("status")).toHaveText(labels.saving);
  await expect.poll(async () => (await observe(page, `${phase}-resumed`)).focusWithin).toBe(true);
  await assertReviewedDraft(page);
  await pointerAttempt(page, `${phase}-resumed`);
  expect.soft((await observe(page, `${phase}-resumed-after-pointer`)).focusWithin,
    `${phase}: the resumed busy action must keep focus inside`).toBe(true);
  expect(gate.attempts).toHaveLength(expectedCount);
  expect(gate.held.size).toBe(1);
  expect(delivered(state)).toHaveLength(expectedCount - 1);
  gate.releasePhase(phase);
  await expect(dialogFor(page).getByRole("alert")).toHaveText(labels.unknown);
  await expect(dialogFor(page).getByRole("button", { name: labels.retry, exact: true })).toBeEnabled();
  await expect.poll(() => gate.active + state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  await assertReviewedDraft(page);
  expect(gate.attempts).toHaveLength(expectedCount);
  expect(delivered(state)).toHaveLength(expectedCount);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state, gate, validationGate } = run;
  gate.releaseAll(); validationGate.releaseAll(); run.liveDetail?.releaseAll(); state.releaseRelated(); state.release();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  try {
    await expect.poll(() => gate.active + gate.held.size + validationGate.active + validationGate.held.size + state.inflight + state.pendingBrowserRequests.size
      + state.pendingProofs + state.held.length + state.heldRelated.length
      + (run.liveDetail?.active ?? 0) + (run.liveDetail?.held.size ?? 0)).toBe(0);
  } catch (error) { drainError = String(error); }
  state.observationCutoff = Date.now();
  const afterInputs = hashes(inputPaths), afterSource = hashes(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const receiptPath = info.outputPath("a04-handoff-busy-action-ledger.json");
  writeFileSync(receiptPath, JSON.stringify({
    scope: "Actual preserved AppShell with inherited strict synthetic HTTP/WebSocket; first-save metadata and publication requests held then fallen through unchanged; no live authorization or release claim.",
    status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: "pt-BR", manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, beforeSource: run.beforeSource, afterSource,
    observations: run.observations, gateAttempts: gate.attempts, validationGateAttempts: validationGate.attempts,
    httpFaults: run.httpFaults ?? [],
    liveDetailOverride: run.liveDetail ? { path: sessionPath, method: "GET", mechanism: "Explicit active-session metadata fixture; title populated through owner-event refetch, never query/provider state",
      eventArmedAt: run.liveDetail.eventArmedAt, newTitle: run.liveDetail.newTitle, reads: run.liveDetail.reads } : null,
    validationBaseline: run.validationBaseline, queuedValidationAttempts: validationGate.attempts.length,
    browserQueuedMetadataRequests: queuedMetadata(state).length, deliveredMetadataRequests: deliveredMetadata(state).length,
    queuedPublicationAttempts: gate.attempts.length, deliveredPublicationRequests: delivered(state).length,
    assets, screenshotError, drainError,
    cutoff: { at: state.observationCutoff, complete: drainError === null, inflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()], pendingProofs: state.pendingProofs,
      gateActive: gate.active, gateHeld: gate.held.size, validationGateActive: validationGate.active,
      validationGateHeld: validationGate.held.size, liveDetailActive: run.liveDetail?.active ?? 0,
      liveDetailHeld: run.liveDetail?.held.size ?? 0, held: state.held.length + state.heldRelated.length },
    observationLimit: "The explicit cutoff excludes subsequent page closure and runner teardown; late observed events are marked by the inherited fixture.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests,
    sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-handoff-busy-action-ledger", { path: receiptPath, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  expect.soft(gate.attempts.filter((attempt) => attempt.error || !attempt.fallbackCompletedAt)).toEqual([]);
  expect.soft(validationGate.attempts.filter((attempt) => attempt.error || !attempt.fallbackCompletedAt)).toEqual([]);
  for (const suffix of ["index.html", ".js", ".css"]) expect.soft(assets.some((asset) => asset.manifestKey.endsWith(suffix))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED")
    || ![contentsPath, `${sessionPath}/calls`, `${sessionPath}/links`, notePath, cardApi, "/api/me/sessions"]
      .some((prefix) => failure.startsWith(prefix)))).toEqual([]);
  runs.delete(page);
});

test("A04 held validation, first Save and unknown-outcome Retry preserve focus and suppress duplicates across Hide and Resume", async ({ page }) => {
  expect(manifest, "Root must provide the preserved built-asset manifest").not.toBeNull();
  const state = await installA04Fixture(page, "pt-BR");
  const gate = await installPublicationGate(page);
  const validationGate = await installValidationGate(page);
  runs.set(page, { state, gate, validationGate, validationBaseline: null,
    beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  try {
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
    // This is the last explicit focus assignment. All later activation is native
    // keyboard traversal or coordinate pointer input, including pending actions.
    runs.get(page)!.validationBaseline = { browserQueued: queuedMetadata(state).length, fixtureDelivered: deliveredMetadata(state).length };
    validationGate.arm();
    await activate(dialog.getByRole("button", { name: labels.save, exact: true }));
    await exerciseHeldValidation(page);
    await exerciseHeldAttempt(page, "first-save", 1);
    const frozenPayload = gate.attempts[0]!.payload;
    const frozen = JSON.parse(frozenPayload) as { title: string; content: string; excerpt_source: { items: { content_id: string }[] } };
    expect(frozen.title).toBe(privateDraftTitle); expect(frozen.content).toContain(privateDraftBody);
    expect(frozen.excerpt_source.items.map((item) => item.content_id)).toEqual([contentId(152)]);
    expect(delivered(state)[0]?.payload).toBe(frozenPayload);
    gate.setPhase("retry");
    await keyboardReach(page, labels.retry);
    await page.keyboard.press("Enter");
    await exerciseHeldAttempt(page, "retry", 2);
    expect(gate.attempts[1]?.payload).toBe(frozenPayload);
    expect(delivered(state).map((request) => request.payload)).toEqual([frozenPayload, frozenPayload]);
    expect(state.noteWrites).toEqual([]);
    expect(state.requests.filter((request) => request.method !== "GET"
      && !(request.method === "POST" && [publicationPath, `${contentsPath}/metadata`].includes(request.path)))).toEqual([]);
    const exposed = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
      local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(exposed).not.toContain(privateDraftTitle); expect(exposed).not.toContain(privateDraftBody);
    await keyboardReach(page, labels.hide);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(reader.getByRole("button", { name: labels.resume, exact: true })).toBeVisible();
    await expect(page.locator(`#content-${contentId(101)}`)).toBeAttached();
    await expect(page.locator(`#content-${contentId(200)}`)).toBeAttached();
    await expect(selected.getByRole("checkbox")).toBeChecked();
    expect(gate.attempts).toHaveLength(2); expect(delivered(state)).toHaveLength(2);
  } finally {
    // Also releases any unexpected duplicate before afterEach drains/captures.
    gate.releaseAll(); validationGate.releaseAll();
  }
});


test("A08 rejected first-save validation and Recheck recovery retain the reviewed draft and modal focus without publishing", async ({ page }) => {
  expect(manifest, "Root must provide the preserved built-asset manifest").not.toBeNull();
  const state = await installA04Fixture(page, "pt-BR");
  const gate = await installPublicationGate(page);
  const validationGate = await installValidationGate(page);
  runs.set(page, { state, gate, validationGate, validationBaseline: null, httpFaults: [],
    beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  try {
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
    const run = runs.get(page)!;
    const baseline = { browserQueued: queuedMetadata(state).length, fixtureDelivered: deliveredMetadata(state).length };
    run.validationBaseline = baseline;
    expect(state.metadataStatus).toBe(200);
    const fault: HttpFault = { path: metadataPath, method: "POST", mechanism: "inherited metadataStatus override",
      armedAt: Date.now(), priorStatus: state.metadataStatus, status: 503,
      body: JSON.stringify({ detail: "Synthetic selected metadata unavailable" }) };
    run.httpFaults!.push(fault);
    // HTTP fault injection only: the unchanged fixture still validates the
    // request and serializes its actual 503; no application state is touched.
    state.metadataStatus = fault.status;
    validationGate.arm();
    await activate(dialog.getByRole("button", { name: labels.save, exact: true }));
    await exerciseHeldValidation(page);
    await expect(dialog.getByRole("alert")).toHaveText(labels.sourceCheckFailed);
    await expect(dialog.getByRole("status").filter({ hasText: pt.sessions.contents.excerpt.validating })).toHaveCount(0);
    await expect.poll(() => validationGate.active + gate.active + state.inflight
      + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
    await expect.soft.poll(async () => (await observe(page, "validation-rejected-settled")).focusWithin,
      "refused first-save validation must leave keyboard focus inside the still-open reviewed draft").toBe(true);
    await assertReviewedDraft(page);
    await expect(dialog.getByRole("button", { name: labels.hide, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: labels.recheck, exact: true })).toBeEnabled();
    // Invalid idle Save retains native disabling; this is distinct from the
    // focus-preserving busy state and must not authorize publication.
    await expect(dialog.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
    const responses = state.responseReceipts.filter((response) => response.path === metadataPath && response.observedAt >= fault.armedAt);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ status: fault.status, bytes: Buffer.byteLength(fault.body), sha256: sha(fault.body) });
    expect(JSON.parse(validationGate.attempts[0]!.payload).content_ids).toEqual([contentId(152)]);
    expect(deliveredMetadata(state).at(-1)?.status).toBe(503);
    expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
    await pointerAttempt(page, "validation-rejected-invalid-idle-save");
    await assertReviewedDraft(page);
    expect(validationGate.attempts).toHaveLength(1);
    expect(queuedMetadata(state)).toHaveLength(baseline.browserQueued + 1);
    expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered + 1);
    expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
    expect(state.noteWrites).toEqual([]);
    expect(state.requests.filter((request) => request.method !== "GET"
      && !(request.method === "POST" && request.path === metadataPath))).toEqual([]);
    await expect(selected.getByRole("checkbox")).toBeChecked();
    const exposed = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
      local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(exposed).not.toContain(privateDraftTitle); expect(exposed).not.toContain(privateDraftBody);
    const recheck = dialog.getByRole("button", { name: labels.recheck, exact: true });
    await keyboardReach(page, labels.recheck);
    const originalRecheck = await recheck.elementHandle();
    for (const status of [503, 200] as const) {
      const before = queuedMetadata(state).length;
      state.metadataStatus = status;
      validationGate.arm();
      await page.keyboard.press("Enter");
      await expect.poll(() => validationGate.held.size).toBe(1);
      await expect(recheck).toBeFocused();
      await expect(recheck).not.toHaveAttribute("disabled");
      await expect(recheck).toHaveAttribute("aria-busy", "true");
      await expect(recheck).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(queuedMetadata(state)).toHaveLength(before + 1);
      await observe(page, `recheck-${status}-held`);
      validationGate.releaseAll();
      await expect.poll(() => validationGate.active + state.inflight + state.pendingBrowserRequests.size).toBe(0);
      if (status === 503) {
        await expect(recheck).toBeFocused();
        await expect(recheck).not.toHaveAttribute("aria-busy", "true");
        expect(await recheck.evaluate((button, original) => button === original, originalRecheck)).toBe(true);
      } else {
        await expect(recheck).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: pt.sessions.contents.excerpt.cancel, exact: true })).toBeFocused();
        await expect(dialog.getByRole("button", { name: labels.save, exact: true })).toBeEnabled();
      }
      await assertReviewedDraft(page);
      expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
      expect(state.noteWrites).toEqual([]);
      await observe(page, `recheck-${status}-settled`);
    }
  } finally {
    gate.releaseAll(); validationGate.releaseAll();
  }
});

type LiveDetailRead = { phase: "untitled" | "captured-title"; title: string | null; startedAt: number;
  body: string; bytes: number; sha256: string; releasedAt?: number; completedAt?: number; error?: string };

async function installLiveDetailFixture(page: Page, state: A04Fixture) {
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const newTitle = "SYNTHETIC NEWLY CAPTURED TITLE AFTER HANDOFF REVIEW";
  const reads: LiveDetailRead[] = [], held = new Map<LiveDetailRead, () => void>();
  let eventArmedAt: number | null = null, active = 0, closed = false;
  // This is an explicit response override, not fallback masquerading as the
  // ended-session fixture. All remaining routes retain the strict fixture.
  await page.route((url) => url.pathname === sessionPath, async (route) => {
    const request = route.request(), url = new URL(request.url());
    const receipt: RequestReceipt = { path: url.pathname, query: url.search, method: request.method(),
      mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1; active += 1;
    let read: LiveDetailRead | undefined;
    try {
      assert.equal(url.origin, origin); assert.equal(request.method(), "GET"); assert.equal(url.search, "");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      assert.equal(state.authorityStatus, 200, "This live-refresh case retains its original authorized owner");
      const updated = eventArmedAt !== null;
      const title = updated ? newTitle : null;
      const body = JSON.stringify({ ...session, title, status: "active", display_state: "active",
        ended_at: null, ended_reason: null, idle_since: null, link_count: linksFor(state).length,
        last_event_at: updated ? "2026-10-17T03:19:00Z" : session.last_event_at,
        prompt_count: session.prompt_count + (updated ? 1 : 0), event_count: session.event_count + (updated ? 1 : 0) });
      read = { phase: updated ? "captured-title" : "untitled", title, startedAt: receipt.startedAt,
        body, bytes: Buffer.byteLength(body), sha256: sha(body) };
      reads.push(read);
      if (updated && !closed) {
        const current = read;
        await new Promise<void>((resolve) => held.set(current, () => {
          current.releasedAt = Date.now(); held.delete(current); resolve();
        }));
      } else read.releasedAt = Date.now();
      receipt.status = 200; receipt.bytes = read.bytes;
      await route.fulfill({ status: 200, contentType: "application/json", body });
      read.completedAt = Date.now();
    } catch (error) {
      if (read) read.error = String(error);
      state.unexpected.push(`Live session detail override failed: ${String(error)}`);
      await route.fulfill({ status: 500, json: { detail: "Synthetic live detail fixture contract failed" } }).catch(() => {});
    } finally { state.inflight -= 1; active -= 1; }
  });
  return { reads, held, newTitle, get active() { return active; }, get eventArmedAt() { return eventArmedAt; },
    armTitle() { eventArmedAt = Date.now(); },
    releaseAll() { closed = true; for (const release of held.values()) release(); },
  };
}

test("A04 live captured-title refresh during held Save validation retains action focus and refuses the stale draft", async ({ page }) => {
  expect(manifest, "Root must provide the exact V2 built-asset manifest").not.toBeNull();
  const state = await installA04Fixture(page, "pt-BR");
  const gate = await installPublicationGate(page), validationGate = await installValidationGate(page);
  const liveDetail = await installLiveDetailFixture(page, state);
  runs.set(page, { state, gate, validationGate, liveDetail, validationBaseline: null,
    beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [] });
  try {
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
    const dialog = dialogFor(page), save = dialog.getByRole("button", { name: labels.save, exact: true });
    await dialog.getByRole("combobox", { name: labels.workspace, exact: true }).selectOption(slug);
    await dialog.getByRole("combobox", { name: labels.board, exact: true }).selectOption(boardId);
    await dialog.getByRole("textbox", { name: labels.title, exact: true }).fill(privateDraftTitle);
    await dialog.locator("[contenteditable='true']").fill(privateDraftBody);
    await expect(save).toBeEnabled();
    await expect.poll(() => state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
    expect(liveDetail.reads.length).toBeGreaterThan(0);
    for (const read of liveDetail.reads) {
      expect(read.phase).toBe("untitled");
      expect(JSON.parse(read.body)).toMatchObject({ title: null, status: "active", display_state: "active", ended_at: null, owner_id: "owner" });
    }
    const run = runs.get(page)!;
    const baseline = { browserQueued: queuedMetadata(state).length, fixtureDelivered: deliveredMetadata(state).length };
    run.validationBaseline = baseline;
    validationGate.arm();
    // Last explicit focus assignment. All subsequent focus checks observe the
    // same live modal without repairing focus or injecting validity props.
    await activate(save);
    await expect.poll(() => validationGate.attempts.length).toBe(1);
    await expect(dialog.getByRole("status")).toHaveText(pt.sessions.contents.excerpt.validating);
    await expect(save).toBeFocused();
    expect((await observe(page, "live-save-before-owner-event")).focusWithin).toBe(true);
    expect(validationGate.held.size).toBe(1);
    expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered);
    expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);

    await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
    expect(state.socket).toBeDefined();
    liveDetail.armTitle();
    state.ownerBurst(1);
    const events = state.socketLedger.filter((entry) => entry.kind === "event");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ event: "agent_session.updated", payload: { owner_id: "owner", session_id: session.id } });
    // The actual owner-event invalidation must cancel/refetch selected metadata.
    // Detail remains held until that replacement request is demonstrably queued.
    await expect.poll(() => validationGate.attempts.length).toBe(2);
    await expect.poll(() => liveDetail.held.size).toBe(1);
    await expect.poll(() => queuedMetadata(state).slice(baseline.browserQueued)
      .filter((request) => request.failure === "net::ERR_ABORTED").length).toBe(1);
    expect(validationGate.held.size).toBe(2);
    expect(queuedMetadata(state)).toHaveLength(baseline.browserQueued + 2);
    expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered);
    expect(validationGate.attempts[0]?.payload).toBe(validationGate.attempts[1]?.payload);
    for (const attempt of validationGate.attempts) expect(JSON.parse(attempt.payload).content_ids).toEqual([contentId(152)]);
    await expect(save).toBeFocused();
    liveDetail.releaseAll();
    await expect(page.locator("main h1")).toHaveText(liveDetail.newTitle);
    await expect(dialog.getByRole("alert")).toHaveText(labels.sourceChanged);
    await expect(dialog.getByRole("status")).toHaveText(pt.sessions.contents.excerpt.validating);
    expect(validationGate.held.size).toBe(2);
    expect(deliveredMetadata(state)).toHaveLength(baseline.fixtureDelivered);
    const changed = await observe(page, "live-title-committed-with-replacement-validation-held");
    expect.soft(changed.focusWithin, "an independently refreshed title must not eject focus during Save validation").toBe(true);
    await expect.soft(save).toBeFocused();
    await assertReviewedDraft(page);
    expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0);
    await page.screenshot({ path: test.info().outputPath("live-title-stale-while-validation-held.png") });

    validationGate.releaseAll();
    await expect(dialog.getByRole("status").filter({ hasText: pt.sessions.contents.excerpt.validating })).toHaveCount(0);
    await expect.poll(() => validationGate.active + liveDetail.active + gate.active + state.inflight
      + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
    await expect(dialog.getByRole("alert")).toHaveText(labels.sourceChanged);
    await expect.soft.poll(async () => (await observe(page, "live-stale-validation-refused")).focusWithin,
      "settling a stale first-save check must leave focus inside the reviewed draft").toBe(true);
    await assertReviewedDraft(page);
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole("button", { name: labels.hide, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: labels.recheck, exact: true })).toBeEnabled();
    expect(validationGate.attempts).toHaveLength(2);
    const validationRequests = queuedMetadata(state).slice(baseline.browserQueued);
    expect(validationRequests).toHaveLength(2);
    expect(validationRequests[0]?.failure).toBe("net::ERR_ABORTED");
    expect(validationRequests[1]?.failure).toBeUndefined(); expect(validationRequests[1]?.finishedAt).toBeDefined();
    expect(gate.attempts).toHaveLength(0); expect(delivered(state)).toHaveLength(0); expect(state.noteWrites).toEqual([]);
    const changedReads = liveDetail.reads.filter((read) => read.phase === "captured-title");
    expect(changedReads).toHaveLength(1);
    expect(changedReads[0]!.startedAt).toBeGreaterThanOrEqual(liveDetail.eventArmedAt!);
    for (const read of liveDetail.reads) {
      expect(read.error).toBeUndefined(); expect(read.completedAt).toBeDefined();
      expect(state.responseReceipts.some((response) => response.path === sessionPath && response.status === 200
        && response.sha256 === read.sha256 && response.bytes === read.bytes)).toBe(true);
    }
    const metadataSuccesses = state.responseReceipts.filter((response) => response.path === metadataPath
      && response.observedAt >= validationGate.attempts[0]!.startedAt && !response.unreadable);
    expect(metadataSuccesses.some((response) => response.status === 200 && !!response.sha256)).toBe(true);
    expect(state.requests.filter((request) => request.method !== "GET"
      && !(request.method === "POST" && request.path === metadataPath))).toEqual([]);
    await expect(selected.getByRole("checkbox")).toBeChecked();
    await expect(page.locator(`#content-${contentId(101)}`)).toBeAttached();
    await expect(page.locator(`#content-${contentId(200)}`)).toBeAttached();
    const exposed = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state,
      local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const privateText of [privateDraftTitle, privateDraftBody, liveDetail.newTitle]) expect(exposed).not.toContain(privateText);
  } finally {
    // The cancelled original, live replacement and detail must all be released
    // even if a precondition fails, so the final cutoff reports actual drainage.
    liveDetail.releaseAll(); validationGate.releaseAll(); gate.releaseAll();
  }
});
