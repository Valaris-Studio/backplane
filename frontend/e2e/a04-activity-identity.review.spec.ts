// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import type { Activity } from "../src/types/activity";
import { boardId, cardId, session, sha, stamp, slug, type RequestReceipt } from "./fixtures/session-window-fixture";
import { cardApi, cardHref, cardTitle, installA04Fixture, privateBodyReads, relatedReads,
  resourceHref, resourceId, unexpectedConsole, workspaceApi, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
// Retain the repository's 90s case / 15s expectation deadlines and zero retries.
const inputPaths = ["e2e/a04-activity-identity.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/pages/Dashboard.tsx", "src/features/dashboard/api/use-dashboard.ts",
  "src/features/dashboard/components/OnboardingChecklist.tsx",
  "src/hooks/useDomainSync.ts", "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/providers/NavigationGuardProvider.tsx", "src/features/kanban/components/BoardView.tsx", "src/features/kanban/components/CardDetailSheet.tsx"];
const hashFiles = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;
const summaryPath = `${workspaceApi}/summary`;
const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
const dashboardHref = `/${slug}`;
// Dashboard and its later-mounted checklist each observe this same query with
// refetchOnMount:always. Overlapping requests may share one pending promise.
const maxSummaryReadsPerMount = 2;
const summaryBody = (activities: Activity[]) => JSON.stringify({ board_count: 1, card_count: 1, note_count: 1, channel_count: 1,
  recent_activity: activities, board_stats: [], activity_trend: [] });

function activity(id: string, summary: string, kind: "card" | "resource" = "card"): Activity {
  return { id, workspace_id: session.workspace_id, board_id: boardId, actor_id: "owner", actor_name: "Synthetic operator",
    actor_email: null, agent_id: null, entity_type: kind, entity_id: kind === "card" ? cardId : resourceId,
    action: kind === "card" ? "updated" : "uploaded", summary, message_key: null, message_params: null,
    via_api_key: null, entity_title: null, created_at: stamp };
}
const original = activity("a04-activity-original", "Synthetic original activity to resume");
const older = activity("a04-activity-older-same-target", "Synthetic earlier activity for the same card");
const inserted = activity("a04-activity-newer-same-target", "Synthetic new activity received while away");
const otherTarget = activity("a04-activity-resource-control", "Synthetic different-target resource activity", "resource");
type SummaryRead = { phase: "initial" | "while-away"; startedAt: number; deliveredAt?: number; ids: string[];
  body: string; bytes: number; sha256: string; status?: number };
type Feed = { phase: SummaryRead["phase"]; activities: Activity[]; changedAt: number | null; reads: SummaryRead[] };
type Run = { state: A04Fixture; feed: Feed; inputBefore: ReturnType<typeof hashFiles>;
  sourceBefore: ReturnType<typeof hashFiles>; observations: unknown[] };
const runs = new Map<Page, Run>();
const path = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };
const historyEntry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx }));
const rows = (page: Page) => page.getByTestId("recent-activity-card").locator("[data-activity-id]");
const rowIds = (page: Page) => rows(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-activity-id")));
const activityLink = (page: Page, summary: string) => page.getByTestId("recent-activity-card").getByRole("link", { name: summary, exact: true });

async function installFeed(page: Page, state: A04Fixture): Promise<Feed> {
  const feed: Feed = { phase: "initial", activities: [original, older, otherTarget], changedAt: null, reads: [] };
  // This single explicit aggregate override is recorded separately. Every other
  // route falls through to the unchanged strict A04 HTTP/asset fixture.
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname !== summaryPath) return route.fallback();
    const receipt: RequestReceipt = { path: url.pathname, method: request.method(), query: url.search,
      mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    try {
      assert.equal(url.origin, origin, "The controlled aggregate stays on the preserved app origin");
      assert.equal(request.method(), "GET"); assert.equal(url.search, "");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      const body = summaryBody(feed.activities);
      const read: SummaryRead = { phase: feed.phase, startedAt: receipt.startedAt, ids: feed.activities.map((item) => item.id),
        body, bytes: Buffer.byteLength(body), sha256: sha(body) };
      feed.reads.push(read); receipt.ids = read.ids; receipt.bytes = read.bytes; receipt.status = 200;
      await route.fulfill({ status: 200, contentType: "application/json", body });
      read.deliveredAt = Date.now(); read.status = 200;
    } catch (error) {
      state.unexpected.push(`Activity aggregate override failed: ${String(error)}`);
      await route.fulfill({ status: 500, json: { detail: "Synthetic activity aggregate contract failed" } }).catch(() => {});
    } finally { state.inflight -= 1; }
  });
  return feed;
}

async function drained(state: A04Fixture) {
  await expect.poll(() => state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  const observation = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { at: Date.now(), href: location.href, history: history.state,
      focus: active ? { id: active.id, tag: active.tagName, text: active.textContent,
        activityId: active.closest("[data-activity-id]")?.getAttribute("data-activity-id") ?? null } : null,
      rows: [...document.querySelectorAll("[data-testid=recent-activity-card] [data-activity-id]")].map((row) => ({
        id: row.getAttribute("data-activity-id"), text: row.textContent, href: row.querySelector("a")?.getAttribute("href") })),
      scrollY, viewport: { width: innerWidth, height: innerHeight },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth };
  });
  run.observations.push({ name, ...observation, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect(observation.reducedMotion).toBe(true); expect(observation.horizontalOverflow).toBeLessThanOrEqual(1);
  return observation;
}

async function assertOpaqueContext(page: Page) {
  const context = await page.evaluate(() => ({ href: location.href, history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage } }));
  const encoded = JSON.stringify(context);
  for (const item of [original, older, inserted, otherTarget]) {
    expect(encoded).not.toContain(item.id); expect(encoded).not.toContain(item.summary);
  }
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state, feed } = run;
  state.releaseRelated(); state.release();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  const seal = (complete: boolean) => {
    state.observationCutoff = Date.now();
    return { complete, cutoffAt: state.observationCutoff, fixtureInflight: state.inflight,
      pendingRequests: [...state.pendingBrowserRequests.values()].map((request) => ({ ...request })),
      pendingProofs: state.pendingProofs, proofsStarted: state.proofsStarted, heldRequests: state.held.length + state.heldRelated.length };
  };
  let completion: ReturnType<typeof seal> | null = null;
  try {
    await expect.poll(() => {
      if (state.inflight || state.pendingBrowserRequests.size || state.pendingProofs || state.held.length || state.heldRelated.length) return false;
      completion = seal(true); return true;
    }).toBe(true);
  } catch (error) { drainError = String(error); }
  const completed = completion ?? seal(false);
  const inputAfter = hashFiles(inputPaths), sourceAfter = hashFiles(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const observedAssets = assets.filter((asset) => !asset.afterCutoff);
  const coverage = { html: observedAssets.filter((asset) => asset.manifestKey === "index.html").length,
    js: observedAssets.filter((asset) => /\.js$/.test(asset.manifestKey)).length,
    css: observedAssets.filter((asset) => /\.css$/.test(asset.manifestKey)).length };
  const receipt = info.outputPath("a04-activity-identity-ledger.json");
  writeFileSync(receipt, JSON.stringify({
    scope: "Actual preserved AppShell, synthetic authorized HTTP metadata and destination. No deployed authorization or A08 acceptance claim.",
    status: info.status, baseURL: process.env.BACKPLANE_E2E_BASE_URL, browser: page.context().browser()?.version(), locale: "en",
    viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    inputsBefore: run.inputBefore, inputsAfter: inputAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
    summaryOverride: { path: summaryPath, method: "GET", changedWhileAwayAt: feed.changedAt, reads: feed.reads,
      mechanism: "Changed durable HTTP fixture while Dashboard was unmounted; real refetchOnMount always reads it on native Back. No event, cache or provider injection." },
    observations: run.observations, completion: completed, assetCoverage: coverage, assets, screenshotError, drainError,
    observationScope: "Evidence ends at the explicit drained cutoff. Later observed events are marked; attachment, page closure and runner teardown are outside it.",
    browserRequests: state.browserRequests, afterCutoffEvents: state.afterCutoffEvents, requests: state.requests,
    responses: state.responseReceipts, sockets: state.socketLedger, unexpected: state.unexpected, failures: state.failures,
    console: state.consoleReceipts, unexpectedConsole: unexpectedConsole(state), noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-activity-identity-ledger", { path: receipt, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(inputAfter).toEqual(run.inputBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
  expect.soft(coverage.html).toBeGreaterThan(0); expect.soft(coverage.js).toBeGreaterThan(0); expect.soft(coverage.css).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.responseReceipts.filter((response) => response.unreadable || response.status !== 200)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]); expect.soft(state.failures).toEqual([]);
  expect.soft(state.requests.filter((request) => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  expect.soft(state.noteWrites).toEqual([]);
  runs.delete(page);
});

test("A04 native Back restores the originating activity after same-target insertion and reordering", async ({ page }) => {
  expect(manifest, "Root must bind this run to the exact preserved dist manifest").not.toBeNull();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await installA04Fixture(page, "en"), feed = await installFeed(page, state);
  runs.set(page, { state, feed, inputBefore: hashFiles(inputPaths), sourceBefore: hashFiles(sourcePaths), observations: [] });
  await page.goto(dashboardHref);
  await expect(page.getByRole("banner")).toBeVisible(); await expect(page.getByRole("main")).toBeVisible();
  const originalLink = activityLink(page, original.summary), olderLink = activityLink(page, older.summary);
  await expect(originalLink).toBeVisible(); await expect(olderLink).toBeVisible();
  await expect(originalLink).toHaveAttribute("href", cardHref); await expect(olderLink).toHaveAttribute("href", cardHref);
  await expect(activityLink(page, otherTarget.summary)).toHaveAttribute("href", resourceHref);
  expect(await rowIds(page)).toEqual([original.id, older.id, otherTarget.id]);
  // Locate by actual visible authorized summary first, then verify its record
  // identity in the rendered row. No cache/provider state or new link ID oracle.
  expect(await originalLink.evaluate((link) => link.closest("[data-activity-id]")?.getAttribute("data-activity-id"))).toBe(original.id);
  expect(await rows(page).first().innerText()).toContain(original.summary);
  const filter = page.getByTestId("activity-type-chip-card");
  await filter.focus(); await filter.press("Enter"); await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(activityLink(page, otherTarget.summary)).toHaveCount(0);
  expect(await rowIds(page)).toEqual([original.id, older.id]);
  await drained(state);
  const initialReads = structuredClone(feed.reads);
  expect(initialReads.length).toBeGreaterThanOrEqual(1);
  expect(initialReads.length).toBeLessThanOrEqual(maxSummaryReadsPerMount);
  const initialBody = summaryBody([original, older, otherTarget]);
  for (const read of initialReads) {
    expect(read.phase).toBe("initial"); expect(read.ids).toEqual([original.id, older.id, otherTarget.id]);
    expect(read.body).toBe(initialBody); expect(read.sha256).toBe(sha(initialBody));
    expect(read.bytes).toBe(Buffer.byteLength(initialBody)); expect(read.status).toBe(200);
  }
  runs.get(page)!.observations.push({ name: "initial-aggregate-baseline", at: Date.now(),
    actualCount: initialReads.length, phases: initialReads.map((read) => read.phase), ids: initialReads.map((read) => read.ids) });
  expect(privateBodyReads(state)).toEqual([]); expect(relatedReads(state)).toEqual([]);
  expect(state.requests.filter((request) => request.path === cardApi)).toEqual([]);
  const originEntry = await historyEntry(page);
  await originalLink.focus(); await expect(originalLink).toBeFocused();
  await observe(page, "original-activity-before-departure");
  await originalLink.press("Enter");
  const editor = page.getByRole("dialog", { name: en.cards.editTitle, exact: true });
  await expect(editor.getByRole("textbox", { name: en.cards.titleLabel, exact: true })).toHaveValue(cardTitle);
  expect(path(page)).toBe(cardHref); await drained(state);
  expect(state.requests.some((request) => request.path === cardApi && request.status === 200)).toBe(true);
  expect(await page.evaluate(() => history.state?.usr)).toEqual({ bpReturn: { v: 1, originKey: expect.any(String), originIdx: originEntry.idx } });
  await assertOpaqueContext(page);
  expect(privateBodyReads(state)).toEqual([]); expect(relatedReads(state)).toEqual([]);
  expect(feed.reads).toEqual(initialReads);

  // The next aggregate response inserts a new same-href record and moves the
  // original behind the older record. It remains within the retained five rows.
  feed.phase = "while-away"; feed.activities = [inserted, older, original, otherTarget]; feed.changedAt = Date.now();
  runs.get(page)!.observations.push({ name: "durable-feed-changed-while-away", at: feed.changedAt,
    href: path(page), ids: feed.activities.map((item) => item.id), summaryReads: feed.reads.length,
    additionalReadsWhileAway: feed.reads.length - initialReads.length, phases: feed.reads.map((read) => read.phase), subscriptions: [...state.subscriptions] });
  await page.goBack();
  await expect.poll(() => path(page)).toBe(dashboardHref);
  await expect(activityLink(page, inserted.summary)).toBeVisible(); await drained(state);
  expect(await historyEntry(page)).toEqual(originEntry);
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(activityLink(page, otherTarget.summary)).toHaveCount(0);
  expect(await rowIds(page)).toEqual([inserted.id, older.id, original.id]);
  expect(feed.reads.slice(0, initialReads.length)).toEqual(initialReads);
  const returnedReads = feed.reads.slice(initialReads.length);
  expect(returnedReads.length).toBeGreaterThanOrEqual(1);
  expect(returnedReads.length).toBeLessThanOrEqual(maxSummaryReadsPerMount);
  expect(feed.reads.length).toBeLessThanOrEqual(initialReads.length + maxSummaryReadsPerMount);
  const returnedBody = summaryBody([inserted, older, original, otherTarget]);
  for (const read of returnedReads) {
    expect(read.phase).toBe("while-away"); expect(read.ids).toEqual([inserted.id, older.id, original.id, otherTarget.id]);
    expect(read.startedAt).toBeGreaterThanOrEqual(feed.changedAt!);
    expect(read.body).toBe(returnedBody); expect(read.sha256).toBe(sha(returnedBody));
    expect(read.bytes).toBe(Buffer.byteLength(returnedBody)); expect(read.status).toBe(200);
  }
  runs.get(page)!.observations.push({ name: "returned-aggregate-refresh", at: Date.now(),
    initialCount: initialReads.length, additionalCount: returnedReads.length, totalCount: feed.reads.length,
    phases: feed.reads.map((read) => read.phase), ids: returnedReads.map((read) => read.ids) });
  for (const read of feed.reads) {
    expect(read.status).toBe(200);
    expect(state.responseReceipts.some((response) => response.path === summaryPath && response.status === 200
      && response.sha256 === read.sha256 && response.bytes === read.bytes)).toBe(true);
  }
  for (const item of [inserted, older, original]) await expect(activityLink(page, item.summary)).toHaveAttribute("href", cardHref);
  await assertOpaqueContext(page);
  expect(privateBodyReads(state)).toEqual([]); expect(relatedReads(state)).toEqual([]);
  // Soft only so original-artifact failure still records the actual wrong row,
  // privacy/no-write assertions and complete served-byte/cutoff evidence.
  await expect.soft(originalLink).toBeFocused();
  expect.soft(await activityLink(page, inserted.summary).evaluate((link) => document.activeElement === link)).toBe(false);
  const returned = await observe(page, "returned-activity-after-aggregate-refresh");
  expect.soft(returned.focus?.activityId).toBe(original.id);
  expect(state.requests.filter((request) => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  expect(state.noteWrites).toEqual([]);
});
