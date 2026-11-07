// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardApi, cardId, currentHref, currentTitle, ownerA, sequence, sha, timelineApi, timelinePath,
  unexpectedConsole, type TimelineFixture } from "./fixtures/a05-timeline-navigation";
import { browserLedger, excludedTitle, frameCount, gestureFrames, installScrubFixture, installScrubObserver,
  localFlag, setPhase, summary, type BrowserScrubLedger } from "./fixtures/a05-settled-scrub";

test.skip(process.env.BACKPLANE_E2E_A05_SCRUB_FIXTURE !== "1", "Requires explicit actual-shell settled-scrub fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
type Gesture = "mouse" | "keyboard" | "held-key-idle";
const boardPath = currentHref("card").split("?")[0]!;
const inputPaths = ["e2e/a05-settled-scrub.spec.ts", "e2e/fixtures/a05-settled-scrub.ts", "e2e/fixtures/a05-timeline-navigation.ts",
  "e2e/fixtures/a06-resource-destination.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "playwright.config.ts", "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/components/layout/TabNav.tsx", "src/pages/kanban/BoardLayout.tsx", "src/features/kanban/components/BoardView.tsx",
  "src/features/timeline/api/use-timeline-history.ts", "src/features/timeline/components/TimelineSimulator.tsx",
  "src/features/timeline/components/TimelineScrubber.tsx", "src/features/timeline/components/StepPanel.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A05_ASSET_MANIFEST;
const distPath = process.env.BACKPLANE_E2E_A05_DIST_DIR;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; tree: string; source_manifest: { path: string; sha256: string }; files: Record<string, string>;
} : null;
function buildHashes() {
  assert(manifest && distPath, "Root must provide the exact dist directory and its manifest");
  return Object.fromEntries(Object.keys(manifest.files).map((path) => [path, sha(readFileSync(join(distPath, path)))]));
}
function text(locale: Locale, key: string): string {
  const value = key.split(".").reduce<unknown>((part, name) => part && typeof part === "object" ? (part as Record<string, unknown>)[name] : undefined, catalogs[locale]);
  assert.equal(typeof value, "string", `Missing registered ${locale} label ${key}`); return value as string;
}
const regex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const range = (page: Page, locale: Locale) => page.getByRole("slider", { name: text(locale, "timeline.scrubber.label"), exact: true });
const flag = (page: Page, locale: Locale) => page.getByRole("searchbox", { name: text(locale, "timeline.history.localSearch"), exact: true });
const timelineTab = (page: Page, locale: Locale) => page.getByRole("link", { name: text(locale, "boardTabs.timeline"), exact: true });
const activePriority = (page: Page, locale: Locale) => page.getByRole("button", { name: new RegExp(`^${regex(text(locale, "kanban.filterBar.filter.priorities"))}\\s+1$`) });
interface Run {
  fixture: TimelineFixture; locale: Locale; width: number; gesture: Gesture;
  inputsBefore: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes>; distBefore: Record<string, string>;
  observations: unknown[]; requests: unknown[]; served: { path: string; status: number; bytes: number; sha256: string; expected: string | null }[];
  pending: Promise<void>[]; gestureLedger?: BrowserScrubLedger;
}
const runs = new Map<Page, Run>();
async function settled(fixture: TimelineFixture) {
  await expect.poll(() => fixture.inflight).toBe(0);
  expect(fixture.unexpected).toEqual([]);
}
async function frame(page: Page) {
  // Real elapsed animation frames, never a fake clock or scripted range input.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}
function momentWrites(ledger: BrowserScrubLedger) {
  return ledger.history.filter((entry) => entry.phase === "gesture" && new URL(entry.href).pathname === timelinePath
    && new URL(entry.href).searchParams.has("at"));
}
async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  const state = await page.evaluate(() => ({ url: location.href, history: history.state,
    focusedId: document.activeElement?.id, focusedHref: document.activeElement?.getAttribute("href"),
    focusedTag: document.activeElement?.tagName, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, touchPoints: navigator.maxTouchPoints }));
  run.observations.push({ name, ...state, ledger: await browserLedger(page) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect.soft(state.overflow).toBeLessThanOrEqual(1); expect(state.reducedMotion).toBe(true);
  if (run.width === 390) expect(state.touchPoints).toBeGreaterThan(0);
  if (new URL(state.url).pathname === timelinePath) {
    expect([...new URL(state.url).searchParams.keys()]).toEqual(["at"]);
    const serialized = JSON.stringify(state.history?.usr);
    for (const secret of [localFlag, ownerA, currentTitle, ...run.fixture.store.created.flatMap((entry) => [entry.requestId, entry.generationId])]) {
      expect(state.url).not.toContain(secret); expect(serialized).not.toContain(secret);
    }
  }
  return state;
}

async function enter(page: Page, locale: Locale, width: number, gesture: Gesture) {
  expect(manifest).not.toBeNull(); expect(distPath).toBeTruthy();
  expect(manifest!.source_manifest.sha256).toBe(sha(readFileSync(manifest!.source_manifest.path)));
  const distBefore = buildHashes(); expect(distBefore).toEqual(manifest!.files);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installScrubFixture(page, locale);
  await installScrubObserver(page);
  const run: Run = { fixture, locale, width, gesture, inputsBefore: hashes(inputPaths), sourceBefore: hashes(sourcePaths), distBefore,
    observations: [], requests: [], served: [], pending: [] };
  runs.set(page, run);
  page.on("request", (request) => run.requests.push({ url: request.url(), method: request.method(), type: request.resourceType(),
    navigation: request.isNavigationRequest(), payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/")) return;
    const path = response.request().isNavigationRequest() ? "index.html" : url.pathname.replace(/^\//, "");
    run.pending.push(response.body().then((body) => {
      run.served.push({ path, status: response.status(), bytes: body.length, sha256: sha(body), expected: manifest!.files[path] ?? null });
    }).catch((error: unknown) => fixture.unexpected.push(`Static response unreadable: ${path}: ${String(error)}`)));
  });
  await page.goto(boardPath);
  await expect(page.getByText(currentTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(excludedTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: text(locale, "kanban.filterBar.toggle"), exact: true }).click();
  await page.getByRole("button", { name: text(locale, "kanban.filterBar.filter.priorities"), exact: true }).click();
  await page.getByRole("menuitem", { name: text(locale, "cards.priorities.medium"), exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(activePriority(page, locale)).toBeVisible();
  await expect(page.getByText(excludedTitle, { exact: true })).toHaveCount(0);
  await timelineTab(page, locale).focus(); await expect(timelineTab(page, locale)).toBeFocused();
  await observe(page, "filtered-board-origin");
  await timelineTab(page, locale).press("Enter");
  await expect(range(page, locale)).toHaveAttribute("max", String(frameCount - 1));
  await settled(fixture);
  // A bare timeline route initially selects its real head. Native Home places
  // the real range at the corpus start before the measured held gesture.
  await range(page, locale).press("Home");
  await expect(range(page, locale)).toHaveValue("0");
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(sequence(0));
  await flag(page, locale).fill(localFlag);
  await range(page, locale).focus();
  await settled(fixture); await observe(page, "before-held-gesture");
  await setPhase(page, "gesture");
  return fixture;
}

async function returnJourney(page: Page, finalOffset: number) {
  const run = runs.get(page)!, { fixture, locale } = run;
  await expect(range(page, locale)).toHaveValue(String(finalOffset));
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(sequence(finalOffset));
  await expect(range(page, locale)).toHaveAttribute("aria-valuetext", new RegExp(summary(finalOffset)));
  await settled(fixture);
  run.gestureLedger = await browserLedger(page);
  const writes = momentWrites(run.gestureLedger);
  if (run.gesture === "held-key-idle") {
    expect.soft(writes.length, "Only the separate withheld-release control admits idle settlement plus release").toBeLessThanOrEqual(2);
  } else {
    expect.soft(writes.map((entry) => new URL(entry.href).searchParams.get("at")),
      "One uninterrupted 80-frame held gesture commits exactly its final event once on release").toEqual([sequence(finalOffset)]);
  }
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((entry) => entry.method === "replaceState")).toBe(true);
  expect(new URL(writes.at(-1)!.href).searchParams.get("at")).toBe(sequence(finalOffset));
  await observe(page, "settled-exact-moment"); await setPhase(page, "return");
  await page.getByTestId("step-panel").getByRole("button", { name: text(locale, "timeline.step.details"), exact: true }).click();
  const details = page.getByRole("region", { name: text(locale, "timeline.step.eventDetails"), exact: true });
  const link = details.getByRole("link", { name: text(locale, "timeline.current.card"), exact: true });
  await expect(link).toHaveAttribute("href", currentHref("card")); await link.focus();
  const linkId = await link.getAttribute("id"); expect(linkId).toBeTruthy();
  const origin = await page.evaluate(() => ({ idx: history.state.idx, nonce: history.state.usr?.bpTimeline }));
  const generation = fixture.store.created[0]!;
  await link.press("Enter");
  await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveValue(currentTitle);
  await settled(fixture);
  const reference = await page.evaluate(() => history.state.usr?.bpReturn);
  expect(reference).toMatchObject({ v: 1, originIdx: origin.idx, originKey: expect.any(String) });
  expect(reference.originKey.length).toBeGreaterThan(0);
  await observe(page, "current-card-reference");
  await page.goBack();
  await expect(range(page, locale)).toHaveValue(String(finalOffset));
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(sequence(finalOffset));
  await expect(flag(page, locale)).toHaveValue(localFlag);
  await expect(page.locator(`[id=${JSON.stringify(linkId)}]`)).toBeFocused();
  expect(await page.evaluate(() => history.state.usr?.bpTimeline)).toEqual(origin.nonce);
  expect(fixture.store.created).toEqual([generation]);
  await observe(page, "native-back-timeline");
  await page.goForward();
  await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveValue(currentTitle);
  expect(await page.evaluate(() => history.state.usr?.bpReturn)).toEqual(reference);
  await page.goBack(); await expect(range(page, locale)).toHaveValue(String(finalOffset));
  await expect(page.locator(`[id=${JSON.stringify(linkId)}]`)).toBeFocused();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(boardPath);
  await expect(timelineTab(page, locale)).toBeFocused();
  await expect(activePriority(page, locale)).toBeVisible();
  await expect(page.getByText(currentTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(excludedTitle, { exact: true })).toHaveCount(0);
  await settled(fixture); await observe(page, "native-back-filtered-board");
  expect(fixture.timelineRequests.filter((request) => request.method !== "GET" && request.kind !== "generation")).toEqual([]);
  expect(fixture.store.created).toEqual([generation]);
  expect(fixture.timelineRequests.filter((request) => request.path === `${boardApi}/cards/${cardId}`).every((request) => request.method === "GET")).toBe(true);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  try {
    // Release only this test's real input and synthetic held responses.
    if (!page.isClosed()) { await page.keyboard.up("ArrowRight"); await page.mouse.up(); }
    run.fixture.releaseTimeline();
    let cleanupError: string | null = null;
    try { await expect.poll(() => run.fixture.inflight).toBe(0); } catch (error) { cleanupError = String(error); }
    await Promise.all([...run.pending, ...run.fixture.pendingAssets]);
    const inputsAfter = hashes(inputPaths), sourceAfter = hashes(sourcePaths), distAfter = buildHashes();
    const ledger = page.isClosed() ? null : await browserLedger(page);
    const output = info.outputPath("settled-scrub-ledger.json");
    writeFileSync(output, JSON.stringify({ scope: "Actual built AppShell; trusted mouse/keyboard input, synthetic HTTP/WS. No live authorization or touch-drag claim.",
      status: info.status, gesture: run.gesture, locale: run.locale, viewport: page.viewportSize(), browser: page.context().browser()?.version(),
      baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), distPath,
      buildBaseHead: manifest?.head, buildBaseTree: manifest?.tree, sourceManifest: manifest?.source_manifest,
      allManifestFilesVerified: Object.keys(run.distBefore).length, distBefore: run.distBefore, distAfter,
      inputsBefore: run.inputsBefore, inputsAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
      observations: run.observations, gestureLedger: run.gestureLedger, finalLedger: ledger, allRequests: run.requests, served: run.served,
      requests: run.fixture.requests, timeline: run.fixture.timelineRequests, generations: run.fixture.store.created, socket: run.fixture.socketLedger,
      failures: run.fixture.failures, unexpected: run.fixture.unexpected, console: run.fixture.consoleReceipts,
      unexpectedConsole: unexpectedConsole(run.fixture), cleanupError }, null, 2));
    await info.attach("settled-scrub-ledger", { path: output, contentType: "application/json" });
    if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") });
    expect.soft(cleanupError).toBeNull(); expect.soft(run.fixture.unexpected).toEqual([]); expect.soft(unexpectedConsole(run.fixture)).toEqual([]);
    expect.soft(run.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED") || !failure.startsWith(timelineApi))).toEqual([]);
    expect.soft(inputsAfter).toEqual(run.inputsBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
    expect.soft(distAfter).toEqual(run.distBefore); expect.soft(distAfter).toEqual(manifest!.files);
    expect.soft(run.served.length).toBeGreaterThan(0);
    expect.soft(run.served.filter((entry) => entry.status !== 200 || entry.sha256 !== entry.expected)).toEqual([]);
    expect.soft(run.served.some((entry) => entry.path === "index.html")).toBe(true);
  } finally { runs.delete(page); }
});

for (const [locale, width, gesture] of [["en", 1440, "mouse"], ["es", 390, "keyboard"], ["pt-BR", 390, "held-key-idle"]] as const) {
  test.describe(`${locale} ${width} ${gesture}`, () => {
    test.use({ hasTouch: width === 390 });
    test("commits a settled exact moment with bounded URL writes and preserves the real native return journey", async ({ page }) => {
      await enter(page, locale, width, gesture);
      const slider = range(page, locale);
      if (gesture === "mouse") {
        const box = await slider.boundingBox(); expect(box).not.toBeNull();
        // size-4 is one root rem; this application sets html to 87.5%, so a
        // hard-coded 16px thumb would use the wrong native range endpoints.
        const thumbDiameter = await slider.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        const startX = box!.x + thumbDiameter / 2, y = box!.y + box!.height / 2, travel = box!.width - thumbDiameter;
        expect(travel / (frameCount - 1), "Desktop range must have at least two CSS pixels per discrete event").toBeGreaterThanOrEqual(2);
        runs.get(page)!.observations.push({ name: "native-pointer-geometry", box, thumbDiameter, travel, pixelsPerEvent: travel / (frameCount - 1) });
        await page.mouse.move(startX, y); await page.mouse.down();
        for (let value = 1; value <= gestureFrames; value += 1) {
          await page.mouse.move(startX + travel * value / (frameCount - 1), y); await frame(page);
        }
        // Release immediately after the final frame. Screenshots and locator
        // assertions must not introduce a test-owned idle pause while held.
        await page.mouse.up();
        await expect(slider).toHaveValue(String(gestureFrames));
        const completed = await browserLedger(page);
        const input = completed.input.filter((entry) => entry.phase === "gesture" && entry.type === "input");
        expect(new Set(input.map((entry) => entry.value)).size).toBeGreaterThanOrEqual(gestureFrames);
        expect(input.every((entry) => entry.trusted)).toBe(true);
        const releases = completed.input.filter((entry) => entry.phase === "gesture" && entry.type === "pointerup");
        expect(releases).toHaveLength(1); expect(releases[0]!.trusted).toBe(true);
        expect.soft(momentWrites(completed).filter((entry) => entry.at < releases[0]!.at), "Held mouse previews do not write the URL before release").toEqual([]);
        await observe(page, "mouse-after-single-release");
        await returnJourney(page, gestureFrames);
      } else {
        await slider.focus();
        const count = gesture === "keyboard" ? gestureFrames : 1;
        for (let index = 0; index < count; index += 1) { await page.keyboard.down("ArrowRight"); await frame(page); }
        if (gesture === "keyboard") await page.keyboard.up("ArrowRight");
        await expect(slider).toHaveValue(String(count));
        const held = await browserLedger(page);
        const keys = held.input.filter((entry) => entry.phase === "gesture" && entry.type === "keydown" && entry.key === "ArrowRight");
        expect(keys).toHaveLength(count); expect(keys.every((entry) => entry.trusted)).toBe(true);
        if (count > 1) expect(keys.slice(1).every((entry) => entry.repeat)).toBe(true);
        if (gesture === "held-key-idle") {
          expect(held.input.filter((entry) => entry.phase === "gesture" && entry.type === "keyup" && entry.key === "ArrowRight")).toEqual([]);
          // Withhold the native release until the address catches up. This
          // exercises trailing idle with the normal clock, not fake touchcancel.
          await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(sequence(count));
          const idle = await browserLedger(page);
          expect(idle.input.filter((entry) => entry.phase === "gesture" && entry.type === "keyup" && entry.key === "ArrowRight")).toEqual([]);
          await observe(page, "held-key-idle-settled-without-release");
          await page.keyboard.up("ArrowRight");
        } else {
          const releases = held.input.filter((entry) => entry.phase === "gesture" && entry.type === "keyup" && entry.key === "ArrowRight");
          expect(releases).toHaveLength(1); expect(releases[0]!.trusted).toBe(true);
          expect.soft(momentWrites(held).filter((entry) => entry.at < releases[0]!.at), "Held key previews do not write the URL before release").toEqual([]);
          await observe(page, "keyboard-after-single-release");
        }
        await returnJourney(page, count);
      }
    });
  });
}
