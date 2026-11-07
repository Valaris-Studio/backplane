// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { boardApi, cardId, currentHref, currentNoteTitle, currentTitle, momentURL, noteId, ownerA, ownerB,
  privateFlag, sha, targetSummary, timelineApi, timelinePath, unexpectedConsole } from "./fixtures/a05-timeline-navigation";
import { installDeletedFixture, type DeletedFixture, type DeletedScenario } from "./fixtures/a05-deleted-target";

test.skip(process.env.BACKPLANE_E2E_A05_DELETED_FIXTURE !== "1", "Requires explicit actual-shell deleted-target fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const inputs = ["e2e/a05-deleted-target.spec.ts", "e2e/fixtures/a05-deleted-target.ts", "e2e/fixtures/a05-timeline-navigation.ts",
  "e2e/fixtures/a06-resource-destination.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts",
  "playwright.config.ts", "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sources = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/features/timeline/api/use-timeline-history.ts", "src/features/timeline/components/TimelineSimulator.tsx", "src/features/timeline/components/StepPanel.tsx",
  "src/features/kanban/components/BoardView.tsx", "src/features/kanban/api/use-card-detail.ts", "src/features/notes/components/NoteList.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A05_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; tree: string; source_manifest: { path: string; sha256: string }; files: Record<string, string>;
} : null;
interface Run { fixture: DeletedFixture; locale: Locale; width: number; inputsBefore: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes>;
  observations: unknown[]; requests: unknown[]; documents: unknown[]; pendingDocuments: Promise<void>[] }
const runs = new Map<Page, Run>();

function text(locale: Locale, key: string): string {
  const value = key.split(".").reduce<unknown>((part, name) => part && typeof part === "object" ? (part as Record<string, unknown>)[name] : undefined, catalogs[locale]);
  assert.equal(typeof value, "string", `Registered ${locale} copy: ${key}`); return value as string;
}
const activate = (locator: Locator, width: number) => width === 390 ? locator.tap() : locator.click();
const slider = (page: Page, locale: Locale) => page.getByRole("slider", { name: text(locale, "timeline.scrubber.label"), exact: true });
const details = (page: Page, locale: Locale) => page.getByRole("region", { name: text(locale, "timeline.step.eventDetails"), exact: true });
const currentBodies = (fixture: DeletedFixture) => fixture.timelineRequests.filter((request) => [`${boardApi}/cards/${cardId}`, `${boardApi}/notes/${noteId}`].includes(request.path));
async function settled(fixture: DeletedFixture) { await expect.poll(() => fixture.inflight).toBe(0); expect(fixture.unexpected).toEqual([]); }
async function ready(page: Page, fixture: DeletedFixture, locale: Locale) {
  await expect(slider(page, locale)).toBeVisible();
  await expect(slider(page, locale)).toHaveAttribute("aria-valuetext", new RegExp(targetSummary));
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(momentURL);
  await settled(fixture);
}
async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  const observation = await page.evaluate(() => ({ url: location.href, history: history.state, focusedId: document.activeElement?.id,
    focusedText: document.activeElement?.textContent, bodyText: document.body.innerText,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    touchPoints: navigator.maxTouchPoints, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches }));
  run.observations.push({ name, ...observation });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect.soft(observation.overflow).toBeLessThanOrEqual(1); expect(observation.reducedMotion).toBe(true);
  if (run.width === 390) expect(observation.touchPoints).toBeGreaterThan(0);
  const serialized = JSON.stringify(observation.history?.usr);
  for (const secret of [ownerA, ownerB, privateFlag, ...run.fixture.store.created.flatMap((item) => [item.requestId, item.generationId])]) {
    expect(serialized).not.toContain(secret); expect(observation.url).not.toContain(secret);
  }
}
async function setup(page: Page, locale: Locale, width: number, scenario: DeletedScenario) {
  expect(manifest, "Bind the exact preserved built artifact").not.toBeNull();
  expect(sha(readFileSync(manifest!.source_manifest.path))).toBe(manifest!.source_manifest.sha256);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installDeletedFixture(page, locale, scenario);
  const run: Run = { fixture, locale, width, inputsBefore: hashes(inputs), sourceBefore: hashes(sources), observations: [], requests: [], documents: [], pendingDocuments: [] };
  runs.set(page, run);
  page.on("request", (request) => run.requests.push({ url: request.url(), method: request.method(), type: request.resourceType(),
    navigation: request.isNavigationRequest(), payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }));
  page.on("response", (response) => {
    if (!response.request().isNavigationRequest()) return;
    run.pendingDocuments.push(response.body().then((body) => {
      run.documents.push({ url: response.url(), status: response.status(), bytes: body.length, sha256: sha(body), expected: manifest!.files["index.html"] });
      if (response.status() !== 200 || sha(body) !== manifest!.files["index.html"]) fixture.unexpected.push("Document differs from preserved build");
    }).catch((error: unknown) => { fixture.unexpected.push(`Document unreadable: ${String(error)}`); }));
  });
  await page.goto(momentURL); await ready(page, fixture, locale);
  await page.getByRole("searchbox", { name: text(locale, "timeline.history.localSearch"), exact: true }).fill(privateFlag);
  await activate(page.getByTestId("step-panel").getByRole("button", { name: text(locale, "timeline.step.details"), exact: true }), width);
  await expect(details(page, locale)).toBeVisible();
  expect(currentBodies(fixture)).toEqual([]);
  return fixture;
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  try {
    run.fixture.releaseTimeline();
    let cleanupError: string | null = null;
    try { await expect.poll(() => run.fixture.inflight).toBe(0); } catch (error) { cleanupError = String(error); }
    await Promise.all([...run.pendingDocuments, ...run.fixture.pendingAssets]);
    const inputsAfter = hashes(inputs), sourceAfter = hashes(sources);
    const assets = run.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.slice(1)] ?? null }));
    const output = info.outputPath("deleted-target-ledger.json");
    writeFileSync(output, JSON.stringify({ scope: "Actual built AppShell, synthetic current404/deletion; no live authorization or deployed claim",
      status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
      scenario: run.fixture.scenario, locale: run.locale, viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
      buildBaseHead: manifest?.head, buildBaseTree: manifest?.tree, sourceManifest: manifest?.source_manifest,
      inputsBefore: run.inputsBefore, inputsAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
      observations: run.observations, allRequests: run.requests, documents: run.documents, assets, cleanupError,
      requests: run.fixture.requests, deleted: run.fixture.deletedRequests, timeline: run.fixture.timelineRequests,
      generations: run.fixture.store.created, socket: run.fixture.socketLedger, failures: run.fixture.failures,
      unexpected: run.fixture.unexpected, console: run.fixture.consoleReceipts, unexpectedConsole: unexpectedConsole(run.fixture) }, null, 2));
    await info.attach("deleted-target-ledger", { path: output, contentType: "application/json" });
    if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") });
    expect.soft(cleanupError).toBeNull(); expect.soft(run.fixture.unexpected).toEqual([]); expect.soft(unexpectedConsole(run.fixture)).toEqual([]);
    expect.soft(run.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED") || !failure.startsWith(timelineApi))).toEqual([]);
    expect.soft(inputsAfter).toEqual(run.inputsBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
    expect.soft(assets.length).toBeGreaterThan(0); expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  } finally { runs.delete(page); }
});

const cases = [
  ["card-detail-404", "en", 1440], ["card-omitted", "en", 390], ["note-detail-404", "pt-BR", 390],
  ["card-deletion-event", "es", 1440], ["note-deletion-event", "pt-BR", 390],
] as const;
for (const [scenario, locale, width] of cases) test.describe(`${scenario} ${locale} ${width}`, () => {
  test.use({ hasTouch: width === 390 });
  test("keeps unavailable current identity honest and historical return intact", async ({ page }) => {
    const fixture = await setup(page, locale, width, scenario);
    const kind = scenario.startsWith("card") ? "card" : "note";
    const link = details(page, locale).getByRole("link", { name: text(locale, `timeline.current.${kind}`), exact: true });
    if (scenario.endsWith("deletion-event")) {
      await expect(link).toHaveCount(0);
      expect(fixture.deletedRequests.some((request) => request.kind === "window" && request.status === 200)).toBe(true);
      expect(currentBodies(fixture)).toEqual([]);
      await expect(slider(page, locale)).toBeVisible();
      await observe(page, "historical-deletion-no-current-action");
      return;
    }
    await expect(link).toHaveAttribute("href", currentHref(kind));
    await link.focus(); const linkId = await link.getAttribute("id"); expect(linkId).toBeTruthy();
    const original = fixture.store.created[0]!;
    const nonce = await page.evaluate(() => history.state?.usr?.bpTimeline);
    await observe(page, "before-current-destination");
    if (width === 390) await link.tap(); else await link.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(currentHref(kind), page.url()).pathname);
    if (scenario === "card-omitted") {
      await expect.poll(() => fixture.deletedRequests.some((request) => request.path === boardApi && request.status === 200 && request.ids?.length === 0)).toBe(true);
    } else {
      await expect.poll(() => currentBodies(fixture).some((request) => request.status === 404 && request.intentionalError)).toBe(true);
    }
    await settled(fixture);
    // The shared board GET may finish while the lazy destination still retains
    // Timeline under Suspense. Require the destination's own UI to be mounted.
    if (kind === "card") {
      await expect(page.getByRole("group", { name: text(locale, "collection.viewMode"), exact: true, includeHidden: true })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: text(locale, "notes.boardTitle"), exact: true })).toBeVisible();
    }
    await expect(page.getByTestId("step-panel")).toHaveCount(0);
    await observe(page, "current-target-unavailable");
    // Soft assertions preserve the native-return evidence even when the
    // current destination incorrectly strips its identity or lacks an explanation.
    expect.soft(new URL(page.url()).pathname + new URL(page.url()).search).toBe(currentHref(kind));
    if (kind === "note") {
      await expect.soft(page.getByText(text(locale, "notes.deepLink.unavailable"), { exact: true })).toBeVisible();
      await expect.soft(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveCount(0);
    } else {
      // No new copy or alert-container API is prescribed. A visible explanation
      // must say this requested card is unavailable, rather than silently show a board.
      await expect.soft(page.getByText(/unavailable|not found|no longer.*access|does not exist/i).first()).toBeVisible();
      const saves = page.getByRole("button", { name: text(locale, "common.save"), exact: true });
      if (await saves.count()) await expect.soft(saves).toBeDisabled();
      if (scenario === "card-omitted") await expect.soft(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveCount(0);
    }
    await observe(page, "current-destination-after-explanation-check");
    expect.soft(new URL(page.url()).pathname + new URL(page.url()).search).toBe(currentHref(kind));
    expect(fixture.requests.filter((request) => !["GET", "POST"].includes(request.method))).toEqual([]);
    expect(fixture.requests.filter((request) => request.method === "POST" && request.path !== `${timelineApi}/generations`)).toEqual([]);
    const beforeReturn = fixture.timelineRequests.length;
    await page.goBack(); await ready(page, fixture, locale);
    await expect(details(page, locale)).toBeVisible();
    await expect(page.getByRole("searchbox", { name: text(locale, "timeline.history.localSearch"), exact: true })).toHaveValue(privateFlag);
    await expect(page.locator(`[id=${JSON.stringify(linkId)}]`)).toBeFocused();
    expect(await page.evaluate(() => history.state?.usr?.bpTimeline)).toEqual(nonce);
    expect(fixture.store.created).toEqual([original]);
    expect(fixture.timelineRequests.slice(beforeReturn).filter((request) => request.kind === "generation")).toEqual(expect.arrayContaining([
      expect.objectContaining({ generationId: original.generationId, requestId: original.requestId, status: 200 }),
    ]));
    expect(new URL(page.url()).pathname).toBe(timelinePath);
    await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveCount(0);
    await expect(page.getByText(kind === "card" ? currentTitle : currentNoteTitle, { exact: true })).toHaveCount(0);
    await observe(page, "native-back-exact-history");
  });
});
