// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { currentHref, currentTitle, ownerA, ownerB, sequence, sha, targetSeq, targetSummary, timelineApi, timelinePath,
  unexpectedConsole } from "./fixtures/a05-timeline-navigation";
import { installOverviewFixture, overviewSearch, unsentOverviewSearch, selectedDate, selectedPeriod,
  pageTwoCursor, pageOneFirstSummary, pageTwoFirstSummary, type OverviewFixture } from "./fixtures/a05-timeline-overview-return";

test.skip(process.env.BACKPLANE_E2E_A05_OVERVIEW_FIXTURE !== "1", "Requires explicit actual-shell overview fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });
const catalogs = { en, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const inputs = ["e2e/a05-timeline-overview-return.spec.ts", "e2e/fixtures/a05-timeline-overview-return.ts",
  "e2e/fixtures/a05-timeline-navigation.ts", "e2e/fixtures/a06-resource-destination.ts", "e2e/fixtures/uxc-navigation-fixture.ts",
  "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json", "src/i18n/locales/pt-BR.json"];
const sources = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/features/timeline/api/use-timeline-history.ts", "src/features/timeline/components/TimelineHistoryOverview.tsx",
  "src/features/timeline/components/TimelineSimulator.tsx", "src/features/timeline/components/StepPanel.tsx", "src/features/timeline/utils/timeline-entry.ts"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A05_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; tree: string; source_manifest: { path: string; sha256: string }; files: Record<string, string>;
} : null;

function text(locale: Locale, key: string): string {
  const value = key.split(".").reduce<unknown>((part, name) => part && typeof part === "object" ? (part as Record<string, unknown>)[name] : undefined, catalogs[locale]);
  assert.equal(typeof value, "string", `Registered ${locale} label: ${key}`); return value as string;
}
const activate = (locator: Locator, width: number) => width === 390 ? locator.tap() : locator.click();
const generationRequests = (fixture: OverviewFixture) => fixture.timelineRequests.filter((request) => request.kind === "generation");
const searchRequests = (fixture: OverviewFixture) => fixture.overviewRequests.filter((request) => request.kind === "search");
const slider = (page: Page, locale: Locale) => page.getByRole("slider", { name: text(locale, "timeline.scrubber.label"), exact: true });
const resultPanel = (page: Page, locale: Locale) => page.locator(`div[aria-label=${JSON.stringify(text(locale, "timeline.history.searchResults"))}]`);
const overviewPanel = (page: Page, locale: Locale) => page.getByRole("region", { name: text(locale, "timeline.history.overview"), exact: true });
const input = (page: Page, locale: Locale) => overviewPanel(page, locale).getByRole("searchbox", { name: text(locale, "timeline.history.searchLabel"), exact: true });
const currentLink = (page: Page, locale: Locale) => page.getByRole("region", { name: text(locale, "timeline.step.eventDetails"), exact: true })
  .getByRole("link", { name: text(locale, "timeline.current.card"), exact: true });

interface ReadingPosition { top: number; height: number; total: number; targetOffset: number }
interface Run { fixture: OverviewFixture; locale: Locale; width: number; inputsBefore: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes>;
  observations: unknown[]; requests: unknown[]; responses: unknown[]; pendingResponses: Promise<void>[] }
const runs = new Map<Page, Run>();

async function settled(fixture: OverviewFixture) {
  await expect.poll(() => fixture.inflight).toBe(0); expect(fixture.unexpected).toEqual([]);
}
async function ready(page: Page, fixture: OverviewFixture, locale: Locale, seq = targetSeq) {
  await expect(slider(page, locale)).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(seq);
  if (seq === targetSeq) await expect(slider(page, locale)).toHaveAttribute("aria-valuetext", new RegExp(targetSummary));
  await settled(fixture);
}
async function position(panel: Locator): Promise<ReadingPosition> {
  return panel.evaluate((node, summary) => {
    const target = [...node.querySelectorAll("button")].find((button) => button.textContent?.includes(summary));
    if (!target) throw new Error("The exact page-two search result must be rendered");
    return { top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight,
      targetOffset: target.getBoundingClientRect().top - node.getBoundingClientRect().top };
  }, targetSummary);
}
async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  const panel = resultPanel(page, run.locale);
  const reading = await panel.count() ? await position(panel) : null;
  const state = await page.evaluate(() => ({ url: location.href, history: history.state, focusedId: document.activeElement?.id,
    focusedText: document.activeElement?.textContent, windowScroll: scrollY,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    touchPoints: navigator.maxTouchPoints, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches }));
  run.observations.push({ name, reading, ...state });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect(state.overflow).toBeLessThanOrEqual(1); expect(state.reducedMotion).toBe(true);
  if (run.width === 390) expect(state.touchPoints).toBeGreaterThan(0);
  const serialized = JSON.stringify(state.history?.usr);
  for (const secret of [overviewSearch, unsentOverviewSearch, selectedDate, selectedPeriod, pageTwoCursor, ownerA, ownerB,
    ...run.fixture.store.created.flatMap((generation) => [generation.requestId, generation.generationId])]) {
    expect(serialized).not.toContain(secret); expect(state.url).not.toContain(secret);
  }
  expect([...new URL(state.url).searchParams.keys()]).toEqual(["at"]);
  return state;
}
async function retainedOverview(page: Page, fixture: OverviewFixture, locale: Locale, expected: ReadingPosition, priorRequests: number) {
  await ready(page, fixture, locale);
  const panel = overviewPanel(page, locale), results = resultPanel(page, locale);
  await expect(panel.getByLabel(text(locale, "timeline.history.date"), { exact: true })).toHaveValue(selectedDate);
  await expect(panel.getByRole("combobox", { name: text(locale, "timeline.history.period"), exact: true })).toHaveValue(selectedPeriod);
  await expect(input(page, locale)).toHaveValue(unsentOverviewSearch);
  await expect(results.getByRole("button").filter({ hasText: pageTwoFirstSummary })).toHaveCount(1);
  await expect(results.getByRole("button").filter({ hasText: pageOneFirstSummary })).toHaveCount(0);
  await expect(results.getByRole("button").filter({ hasText: targetSummary })).toHaveCount(1);
  await expect.poll(async () => Math.abs((await position(results)).top - expected.top)).toBeLessThanOrEqual(1);
  const restored = await position(results);
  expect(restored.top).toBeGreaterThan(0); expect(Math.abs(restored.targetOffset - expected.targetOffset)).toBeLessThanOrEqual(1);
  expect(restored.total).toBe(expected.total); expect(restored.height).toBe(expected.height);
  await settled(fixture);
  const requests = searchRequests(fixture).slice(priorRequests);
  expect(requests.length, "Unmounted gcTime-zero search must fetch its retained continuation again").toBeGreaterThan(0);
  expect(requests.every((request) => request.cursor === pageTwoCursor && request.resultPage === 2
    && new URLSearchParams(request.query).get("q") === overviewSearch)).toBe(true);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  try {
    run.fixture.releaseTimeline();
    let cleanupError: string | null = null;
    try { await expect.poll(() => run.fixture.inflight).toBe(0); } catch (error) { cleanupError = String(error); }
    await Promise.all([...run.pendingResponses, ...run.fixture.pendingAssets]);
    const inputsAfter = hashes(inputs), sourceAfter = hashes(sources);
    const assets = run.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.slice(1)] ?? null }));
    const output = info.outputPath("overview-return-ledger.json");
    writeFileSync(output, JSON.stringify({ scope: "Actual built AppShell and overview search continuation; synthetic HTTP/WS; no live authorization claim",
      status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
      locale: run.locale, viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
      buildBaseHead: manifest?.head, buildBaseTree: manifest?.tree, sourceManifest: manifest?.source_manifest,
      inputsBefore: run.inputsBefore, inputsAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
      observations: run.observations, allRequests: run.requests, responses: run.responses, assets, cleanupError,
      requests: run.fixture.requests, overview: run.fixture.overviewRequests, timeline: run.fixture.timelineRequests,
      generations: run.fixture.store.created, socket: run.fixture.socketLedger, failures: run.fixture.failures,
      unexpected: run.fixture.unexpected, console: run.fixture.consoleReceipts, unexpectedConsole: unexpectedConsole(run.fixture) }, null, 2));
    await info.attach("overview-return-ledger", { path: output, contentType: "application/json" });
    if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") });
    expect.soft(cleanupError).toBeNull(); expect.soft(run.fixture.unexpected).toEqual([]); expect.soft(unexpectedConsole(run.fixture)).toEqual([]);
    expect.soft(run.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED") || !failure.startsWith(timelineApi))).toEqual([]);
    expect.soft(inputsAfter).toEqual(run.inputsBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
    expect.soft(assets.length).toBeGreaterThan(0); expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  } finally { runs.delete(page); }
});

for (const [locale, width] of [["en", 1440], ["pt-BR", 390]] as const) test.describe(`${locale} ${width} overview continuation`, () => {
  test.use({ hasTouch: width === 390 });
  test("native return keeps page two, nonzero nested reading position and input edits; hard reload clears only memory state", async ({ page }) => {
    expect(manifest, "Use the preserved actual build manifest").not.toBeNull();
    expect(manifest!.source_manifest.sha256).toBe(sha(readFileSync(manifest!.source_manifest.path)));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const fixture = await installOverviewFixture(page, locale);
    const run: Run = { fixture, locale, width, inputsBefore: hashes(inputs), sourceBefore: hashes(sources), observations: [], requests: [], responses: [], pendingResponses: [] };
    runs.set(page, run);
    page.on("request", (request) => run.requests.push({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), type: request.resourceType(),
      payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }));
    page.on("response", (response) => {
      if (!response.request().isNavigationRequest()) return;
      run.pendingResponses.push(response.body().then((body) => {
        run.responses.push({ url: response.url(), status: response.status(), bytes: body.length, sha256: sha(body), expected: manifest!.files["index.html"] });
        if (response.status() !== 200 || sha(body) !== manifest!.files["index.html"]) fixture.unexpected.push("Document bytes differ from preserved build");
      }).catch((error: unknown) => { fixture.unexpected.push(`Document unreadable: ${String(error)}`); }));
    });
    await page.goto(timelinePath); await ready(page, fixture, locale, sequence(9998));
    const overview = overviewPanel(page, locale);
    const buckets = overview.getByRole("group", { name: text(locale, "timeline.history.activityDistribution"), exact: true }).getByRole("button");
    await expect(buckets).toHaveCount(4);
    await activate(buckets.first(), width); await ready(page, fixture, locale, sequence(0));
    await overview.getByLabel(text(locale, "timeline.history.date"), { exact: true }).fill(selectedDate);
    await overview.getByRole("combobox", { name: text(locale, "timeline.history.period"), exact: true }).selectOption(selectedPeriod);
    await expect(overview.getByRole("group", { name: text(locale, "timeline.history.zoomDetail"), exact: true }).getByRole("button")).toHaveCount(4);
    await input(page, locale).fill(overviewSearch);
    await activate(overview.getByRole("button", { name: text(locale, "timeline.history.search"), exact: true }), width);
    const results = resultPanel(page, locale);
    await expect(results.getByRole("button").filter({ hasText: pageOneFirstSummary })).toHaveCount(1);
    await activate(results.getByRole("button", { name: text(locale, "timeline.history.moreMatches"), exact: true }), width);
    await expect(results.getByRole("button")).toHaveCount(50);
    await expect(results.getByRole("button").filter({ hasText: pageTwoFirstSummary })).toHaveCount(1);
    await expect(results.getByRole("button").filter({ hasText: pageOneFirstSummary })).toHaveCount(0);
    // Native keyboard focus scrolls the actual max-height results container.
    // No style, scrollTop, query cache or application state is injected.
    await results.getByRole("button").first().focus();
    for (let index = 0; index < 40; index += 1) await page.keyboard.press("Tab");
    const target = results.getByRole("button").filter({ hasText: targetSummary });
    await expect(target).toBeFocused(); await expect(target).toBeInViewport();
    const selectedReading = await position(results);
    expect(selectedReading.top).toBeGreaterThan(0); expect(selectedReading.total).toBeGreaterThan(selectedReading.height);
    await observe(page, "page-two-keyboard-reading");
    if (width === 1440) await target.press("Enter"); else await target.tap();
    await ready(page, fixture, locale);
    expect(fixture.timelineRequests.some((request) => request.kind === "window" && new URLSearchParams(request.query).get("at_seq") === targetSeq
      && new URLSearchParams(request.query).get("exact") === "true")).toBe(true);
    await input(page, locale).fill(unsentOverviewSearch);
    await activate(page.getByTestId("step-panel").getByRole("button", { name: text(locale, "timeline.step.details"), exact: true }), width);
    const link = currentLink(page, locale);
    await expect(link).toHaveAttribute("href", currentHref("card")); await link.focus();
    const linkId = await link.getAttribute("id"); expect(linkId).toBeTruthy();
    const before = await position(results); expect(before.top).toBeGreaterThan(0);
    expect(Math.abs(before.top - selectedReading.top)).toBeLessThanOrEqual(1);
    const original = fixture.store.created[0]!, nonce = await page.evaluate(() => history.state?.usr?.bpTimeline);
    const beforeSearch = searchRequests(fixture).length;
    expect(searchRequests(fixture).map((request) => request.resultPage)).toEqual([1, 2]);
    await observe(page, "before-current-link");
    if (width === 1440) await link.press("Enter"); else await link.tap();
    await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveValue(currentTitle);
    await settled(fixture);
    await page.goBack(); await retainedOverview(page, fixture, locale, before, beforeSearch);
    await expect(page.locator(`[id=${JSON.stringify(linkId)}]`)).toBeFocused();
    expect(generationRequests(fixture).at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
    expect(fixture.store.created).toEqual([original]); await observe(page, "native-back-page-two-retained");
    const beforeSecondReturn = searchRequests(fixture).length;
    await page.goForward();
    await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveValue(currentTitle);
    await settled(fixture); await page.goBack();
    await retainedOverview(page, fixture, locale, before, beforeSecondReturn);
    await expect(page.locator(`[id=${JSON.stringify(linkId)}]`)).toBeFocused();
    expect(fixture.store.created).toEqual([original]); await observe(page, "native-forward-and-back-page-two");
    // Inspect the restored reading pane visibly after verifying native-return focus.
    await results.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport(); await observe(page, "restored-reading-pane-visible");
    const beforeReload = searchRequests(fixture).length;
    await page.reload(); await ready(page, fixture, locale);
    expect(await page.evaluate(() => history.state?.usr?.bpTimeline)).toEqual(nonce);
    expect(generationRequests(fixture).at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
    expect(fixture.store.created).toEqual([original]); expect(searchRequests(fixture)).toHaveLength(beforeReload);
    await expect(input(page, locale)).toHaveValue("");
    await expect(overview.getByLabel(text(locale, "timeline.history.date"), { exact: true })).toHaveValue("");
    await expect(overview.getByRole("combobox", { name: text(locale, "timeline.history.period"), exact: true })).toHaveValue("all");
    await expect(results).toHaveCount(0);
    await expect(page.getByRole("region", { name: text(locale, "timeline.step.eventDetails"), exact: true })).toBeHidden();
    await observe(page, "hard-reload-memory-reset");
  });
});
