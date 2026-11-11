// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { bodyFor, boardApi, cardId, currentHref, currentNoteTitle, currentTitle, historicalTitle,
  installTimelineFixture, momentURL, noteId, ownerA, ownerB, privateFlag, privateSearch, resourceId, searchMatch,
  sequence, sha, targetSeq, targetSummary, timelineApi, timelinePath, unexpectedConsole, actorName,
  type Kind, type TimelineFixture } from "./fixtures/a05-timeline-navigation";

test.skip(process.env.BACKPLANE_E2E_A05_TIMELINE_FIXTURE !== "1", "Set BACKPLANE_E2E_A05_TIMELINE_FIXTURE=1 for synthetic actual-shell timeline journeys");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
function text(locale: Locale, key: string): string {
  const value = key.split(".").reduce<unknown>((part, name) => part && typeof part === "object" ? (part as Record<string, unknown>)[name] : undefined, catalogs[locale]);
  assert.equal(typeof value, "string", `Missing registered ${locale} copy: ${key}`);
  return value as string;
}
const fixtureInputs = ["e2e/a05-timeline-navigation.spec.ts", "e2e/fixtures/a05-timeline-navigation.ts", "e2e/fixtures/a06-resource-destination.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts",
  "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sourceInputs = ["src/main.tsx", "src/App.tsx", "src/features/timeline/api/use-timeline-history.ts",
  "src/features/timeline/components/TimelineSimulator.tsx", "src/features/timeline/components/StepPanel.tsx", "src/features/timeline/components/TimelineCardDetail.tsx",
  "src/features/timeline/components/TimelineHistoryOverview.tsx", "src/features/timeline/types.ts", "src/features/timeline/utils/timeline-entry.ts", "src/providers/ReturnNavigationProvider.tsx",
  "src/components/shared/ContextLink.tsx", "src/lib/entity-link.ts", "src/features/resources/components/ResourceList.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A05_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head?: string; tree?: string; source_manifest?: string; files: Record<string, string> } : null;
type Participant = { page: Page; fixture: TimelineFixture; ownedContext?: BrowserContext };
type Run = { participants: Participant[]; locale: Locale; width: number; inputsBefore: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes>;
  observations: unknown[]; http: unknown[]; clock: string };
const runs = new Map<Page, Run>();
const activate = (locator: Locator, width: number) => width === 390 ? locator.tap() : locator.click();
const generations = (fixture: TimelineFixture) => fixture.timelineRequests.filter((request) => request.kind === "generation");
const currentBodies = (fixture: TimelineFixture) => fixture.timelineRequests.filter((request) => [ `${boardApi}/cards/${cardId}`, `${boardApi}/notes/${noteId}` ].includes(request.path));
// A restored historical sheet correctly aria-hides its background. Read-only
// continuity checks still inspect that retained background; actions run before
// opening the sheet or inside its accessible dialog.
const slider = (page: Page, locale: Locale) => page.getByRole("slider", { name: text(locale, "timeline.scrubber.label"), exact: true, includeHidden: true });
const flag = (page: Page, locale: Locale) => page.getByRole("searchbox", { name: text(locale, "timeline.history.localSearch"), exact: true, includeHidden: true });
const details = (page: Page, locale: Locale) => page.getByRole("region", { name: text(locale, "timeline.step.eventDetails"), exact: true, includeHidden: true });

async function settled(fixture: TimelineFixture) {
  await expect.poll(() => fixture.inflight).toBe(0);
  expect(fixture.unexpected).toEqual([]);
}
function recordHTTP(page: Page, run: Run) {
  page.on("request", (request) => { const url = new URL(request.url()); run.http.push({ page: run.participants.findIndex((entry) => entry.page === page),
    method: request.method(), path: url.pathname, query: url.search, type: request.resourceType(), navigation: request.isNavigationRequest(),
    payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }); });
}
async function setup(page: Page, locale: Locale, width: number, kind: Kind = "card") {
  expect(manifest, "An exact preserved build manifest is mandatory").not.toBeNull();
  expect(manifest?.head).toBeTruthy(); expect(manifest?.tree).toBeTruthy(); expect(manifest?.source_manifest).toBeTruthy();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installTimelineFixture(page, locale, { kind });
  const run: Run = { participants: [{ page, fixture }], locale, width, inputsBefore: hashes(fixtureInputs), sourceBefore: hashes(sourceInputs), observations: [], http: [], clock: "normal browser clock" };
  runs.set(page, run); recordHTTP(page, run);
  return fixture;
}
async function ready(page: Page, fixture: TimelineFixture, locale: Locale, exact = targetSeq, settle = true) {
  await expect(page.getByRole("banner", { includeHidden: true })).toBeVisible();
  await expect(slider(page, locale)).toBeVisible();
  const offset = Number(BigInt(exact) - BigInt(sequence(0)));
  await expect(slider(page, locale)).toHaveAttribute("aria-valuetext", new RegExp(exact === targetSeq ? targetSummary : `Retained event ${offset}`));
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(exact);
  if (settle) await settled(fixture);
}
async function openDetails(page: Page, locale: Locale, width: number) {
  await activate(page.getByTestId("step-panel").getByRole("button", { name: text(locale, "timeline.step.details"), exact: true }), width);
  await expect(details(page, locale)).toBeVisible();
}
async function openHistoricalCard(page: Page, locale: Locale, width: number) {
  await activate(page.getByRole("button", { name: text(locale, "timeline.view.dense"), exact: true }), width);
  await activate(page.getByTestId("replay-board").getByRole("button", { name: historicalTitle, exact: true }), width);
  await expect(page.getByRole("dialog", { name: historicalTitle, exact: true })).toBeVisible();
}
async function currentDestination(page: Page, fixture: TimelineFixture, locale: Locale, kind: Kind) {
  if (kind === "card" || kind === "note") {
    await expect(page.getByRole("textbox", { name: text(locale, "cards.titleLabel"), exact: true })).toHaveValue(kind === "card" ? currentTitle : currentNoteTitle);
  } else {
    const dialog = page.getByRole("dialog", { name: "Hidden evidence.txt", exact: true });
    await expect(dialog.locator("pre")).toHaveText(bodyFor(resourceId));
    expect(fixture.resourceRequests.some((request) => request.kind === "detail" && request.resourceId === resourceId)).toBe(true);
    const collection = fixture.resourceRequests.find((request) => request.kind === "collection");
    expect(collection?.ids).not.toContain(resourceId);
  }
  await settled(fixture);
}
function opaqueReferences(usr: unknown): string[] {
  const leaves = (value: unknown): string[] => typeof value === "string" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(leaves) : [];
  const own = usr && typeof usr === "object" ? Object.fromEntries(Object.entries(usr).filter(([key]) => key !== "bpReturn")) : usr;
  return leaves(own).filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
async function privateEntry(page: Page, fixture: TimelineFixture) {
  const captured = await page.evaluate(() => ({ url: location.href, usr: history.state?.usr ?? null, hasSubtle: !!crypto.subtle }));
  expect(captured.hasSubtle).toBe(true);
  expect(opaqueReferences(captured.usr), "Actual entry contains one opaque timeline reference").toHaveLength(1);
  expect([...new URL(captured.url).searchParams.keys()]).toEqual(["at"]);
  const serialized = JSON.stringify(captured.usr);
  for (const secret of [ownerA, ownerB, privateFlag, privateSearch, historicalTitle, currentTitle, currentNoteTitle, actorName,
    ...fixture.store.created.flatMap((generation) => [generation.requestId, generation.generationId])]) {
    expect(serialized).not.toContain(secret); expect(captured.url).not.toContain(secret);
  }
  expect(serialized).not.toContain(targetSeq);
  expect(serialized).not.toContain("events");
  return captured;
}
async function observe(page: Page, name: string, rootPage = page) {
  const run = runs.get(rootPage)!;
  const evidence = await page.evaluate(() => ({ history: history.state, url: location.href, activeId: document.activeElement?.id,
    activeTag: document.activeElement?.tagName, activeText: document.activeElement?.textContent,
    touchPoints: navigator.maxTouchPoints, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    scroll: [...document.querySelectorAll<HTMLElement>("main, [data-app-scrollport], [role='dialog']")].map((node) => ({ role: node.getAttribute("role"), top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight })) }));
  run.observations.push({ name, ...evidence });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect(evidence.overflow).toBeLessThanOrEqual(1); expect(evidence.reducedMotion).toBe(true);
  if (run.width === 390 && page === rootPage) expect(evidence.touchPoints).toBeGreaterThan(0);
  return evidence;
}
async function unavailable(page: Page, fixture: TimelineFixture, locale: Locale, key: string) {
  await expect(page.getByTestId("timeline-error")).toContainText(text(locale, key));
  await expect(slider(page, locale)).toBeHidden();
  await expect(page.getByTestId("step-panel")).toBeHidden();
  await settled(fixture);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  try {
    run.participants.forEach(({ fixture }) => fixture.releaseTimeline());
    let cleanupError: string | null = null;
    try { await expect.poll(() => run.participants.reduce((count, { fixture }) => count + fixture.inflight, 0)).toBe(0); }
    catch (error) { cleanupError = String(error); }
    await Promise.all(run.participants.flatMap(({ fixture }) => fixture.pendingAssets));
    const inputsAfter = hashes(fixtureInputs), sourceAfter = hashes(sourceInputs);
    const assets = run.participants.flatMap(({ fixture }, pageIndex) => fixture.assets.map((asset) => ({ ...asset, pageIndex, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null })));
    const receiptPath = info.outputPath("timeline-navigation-ledger.json");
    writeFileSync(receiptPath, JSON.stringify({ scope: "Actual built AppShell, TimelineSimulator and current destinations; synthetic authorized HTTP/WebSocket, not live authorization or deployment evidence",
      manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), sourceHead: manifest?.head, sourceTree: manifest?.tree, sourceManifest: manifest?.source_manifest,
      baseURL: process.env.BACKPLANE_E2E_BASE_URL, browser: page.context().browser()?.version(), locale: run.locale, viewport: page.viewportSize(), status: info.status,
      cleanupError, inputsBefore: run.inputsBefore, inputsAfter, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter, clock: run.clock,
      assets, observations: run.observations, allRequests: run.http,
      pages: run.participants.map(({ fixture }, index) => ({ index, requests: fixture.requests, timeline: fixture.timelineRequests, resources: fixture.resourceRequests,
        generations: fixture.store.created, socket: fixture.socketLedger, unexpected: fixture.unexpected, failures: fixture.failures,
        console: fixture.consoleReceipts, unexpectedConsole: unexpectedConsole(fixture) })) }, null, 2));
    await info.attach("timeline-navigation-ledger", { path: receiptPath, contentType: "application/json" });
    if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") });
    for (const { fixture } of run.participants) {
      expect.soft(fixture.unexpected).toEqual([]); expect.soft(unexpectedConsole(fixture)).toEqual([]);
      for (const request of generations(fixture)) {
        const state = request.historyState as { usr?: unknown } | null;
        const tokens = opaqueReferences(state?.usr);
        expect.soft(tokens, "Persisted reference is observed by the actual generation interception").toHaveLength(1);
        expect.soft(tokens).not.toContain(request.requestId);
      }
      expect.soft(fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED") || !(failure.startsWith(timelineApi)
        || failure.startsWith("/api/me ") || failure.includes("/resources/")))).toEqual([]);
    }
    expect.soft(cleanupError).toBeNull();
    expect.soft(inputsAfter).toEqual(run.inputsBefore); expect.soft(sourceAfter).toEqual(run.sourceBefore);
    expect.soft(assets.length).toBeGreaterThan(0); expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  } finally {
    await Promise.all(run.participants.map(({ ownedContext }) => ownedContext?.close()));
    runs.delete(page);
  }
});

for (const [locale, kind] of [["en", "card"], ["es", "note"], ["pt-BR", "resource"]] as const) {
  for (const width of [1440, 390]) test.describe(`${locale} ${width} ${kind}`, () => {
    test.use({ hasTouch: width === 390 });
    test("exact historical event opens current work and native Back/Forward restores flags, details and focus", async ({ page }) => {
      const fixture = await setup(page, locale, width, kind);
      await page.goto(momentURL); await ready(page, fixture, locale);
      await expect(page.getByTestId("replay-board").getByText(historicalTitle, { exact: true })).toBeVisible();
      expect(fixture.timelineRequests.some((request) => request.kind === "window" && new URLSearchParams(request.query).get("at_seq") === targetSeq && new URLSearchParams(request.query).get("exact") === "true")).toBe(true);
      expect(currentBodies(fixture)).toEqual([]);
      expect(fixture.resourceRequests.filter((request) => ["sign", "body"].includes(request.kind))).toEqual([]);
      await flag(page, locale).fill(privateFlag); await openDetails(page, locale, width);
      if (kind === "card") await openHistoricalCard(page, locale, width);
      const container = kind === "card" ? page.getByRole("dialog", { name: historicalTitle, exact: true }) : details(page, locale);
      const link = container.getByRole("link", { name: text(locale, `timeline.current.${kind}`), exact: true });
      await expect(link).toHaveAttribute("href", currentHref(kind)); await link.focus();
      const linkId = await link.getAttribute("id"); expect(linkId).toBeTruthy();
      await privateEntry(page, fixture); await observe(page, "historical-before-current");
      const original = fixture.store.created[0]!;
      if (width === 1440) await link.press("Enter"); else await link.tap();
      await currentDestination(page, fixture, locale, kind); await observe(page, "actual-current-destination");
      await page.goBack(); await ready(page, fixture, locale);
      await expect(flag(page, locale)).toHaveValue(privateFlag); await expect(details(page, locale)).toBeVisible();
      if (kind === "card") await expect(page.getByRole("dialog", { name: historicalTitle, exact: true })).toBeVisible();
      await expect(page.locator(`[id="${linkId}"]`)).toBeFocused();
      expect(fixture.store.created).toEqual([original]); await privateEntry(page, fixture); await observe(page, "native-back-restored");
      await page.goForward(); await currentDestination(page, fixture, locale, kind);
      await page.goBack(); await ready(page, fixture, locale);
      await expect(flag(page, locale)).toHaveValue(privateFlag); expect(fixture.store.created).toEqual([original]);
      await observe(page, "native-forward-and-back");
    });
  });
}

for (const [locale, width] of [["en", 1440], ["pt-BR", 390]] as const) test.describe(`${locale} ${width} hard reload`, () => {
  test.use({ hasTouch: width === 390 });
  test("actual reload retains own generation/moment, clears memory-only state and preserves deliberate refresh", async ({ page }) => {
    const fixture = await setup(page, locale, width);
    await page.goto(timelinePath); await ready(page, fixture, locale, sequence(9998));
    await page.getByRole("searchbox", { name: text(locale, "timeline.history.searchLabel"), exact: true }).fill(privateSearch);
    await activate(page.getByRole("button", { name: text(locale, "timeline.history.search"), exact: true }), width);
    await activate(page.getByRole("button").filter({ hasText: searchMatch }), width);
    await ready(page, fixture, locale); await flag(page, locale).fill(privateFlag); await openDetails(page, locale, width);
    await expect(page.getByText(text(locale, "timeline.history.reloadState"), { exact: true })).toBeVisible();
    await openHistoricalCard(page, locale, width);
    const original = fixture.store.created[0]!, before = await privateEntry(page, fixture);
    await page.reload(); await ready(page, fixture, locale);
    expect(generations(fixture).at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
    expect((await privateEntry(page, fixture)).usr).toEqual(before.usr);
    await expect(flag(page, locale)).toHaveValue(""); await expect(details(page, locale)).toBeHidden();
    await expect(page.getByRole("dialog", { name: historicalTitle, exact: true })).toBeHidden();
    await slider(page, locale).focus(); await slider(page, locale).press("ArrowRight");
    await ready(page, fixture, locale, sequence(451)); await expect(slider(page, locale)).toBeFocused();
    await activate(page.getByRole("button", { name: text(locale, "timeline.transport.play"), exact: true }), width);
    await expect(page.getByRole("button", { name: text(locale, "timeline.transport.pause"), exact: true })).toBeVisible();
    await activate(page.getByRole("button", { name: text(locale, "timeline.transport.pause"), exact: true }), width);
    await expect(page.getByRole("button", { name: text(locale, "timeline.transport.pause"), exact: true })).toBeHidden();
    const pausedCaption = await slider(page, locale).getAttribute("aria-valuetext");
    const pausedOffset = /Retained event (\d+)/.exec(pausedCaption ?? "")?.[1];
    expect(pausedOffset).toBeTruthy();
    const pausedAt = sequence(Number(pausedOffset));
    await ready(page, fixture, locale, pausedAt);
    await activate(page.getByRole("button", { name: text(locale, "timeline.history.refresh"), exact: true }), width);
    await expect.poll(() => generations(fixture).some((request) => request.requestId !== original.requestId
      && request.completedAt !== undefined && (request.status === 200 || request.status === 201))).toBe(true);
    await ready(page, fixture, locale, pausedAt);
    const refreshed = fixture.store.created.at(-1)!;
    expect(refreshed.requestId).not.toBe(original.requestId); expect(refreshed.generationId).not.toBe(original.generationId);
    await page.reload(); await ready(page, fixture, locale, pausedAt);
    expect(generations(fixture).at(-1)).toMatchObject({ requestId: refreshed.requestId, generationId: refreshed.generationId, status: 200 });
    expect(fixture.store.created).toHaveLength(2); await privateEntry(page, fixture); await observe(page, "actual-reload-refresh");
  });
});

test("a copied moment URL in another browser context uses its own authorized generation and no origin envelope", async ({ page, browser }) => {
  const fixture = await setup(page, "en", 1440);
  await page.goto(momentURL); await ready(page, fixture, "en"); await flag(page, "en").fill(privateFlag);
  const original = fixture.store.created[0]!, copiedURL = page.url();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const child = await context.newPage();
  const other = await installTimelineFixture(child, "en", { owner: ownerB, store: fixture.store });
  const run = runs.get(page)!; run.participants.push({ page: child, fixture: other, ownedContext: context }); recordHTTP(child, run);
  await child.goto(copiedURL); await ready(child, other, "en");
  expect(generations(other)[0]!.requestId).not.toBe(original.requestId);
  expect(generations(other)[0]!.generationId).not.toBe(original.generationId);
  expect(other.timelineRequests.every((request) => request.generationId !== original.generationId)).toBe(true);
  expect(await child.evaluate(() => history.state?.usr?.bpReturn ?? null)).toBeNull();
  await expect(flag(child, "en")).toHaveValue(""); await privateEntry(child, other); await observe(child, "copied-second-context", page);
  await expect(flag(page, "en")).toHaveValue(privateFlag); expect(page.url()).toBe(copiedURL);
});

test("A→B→A reload identity survives a late committed A response and a real socket reconnect", async ({ page }) => {
  const fixture = await setup(page, "en", 1440); fixture.holdGeneration = true;
  await page.goto(momentURL);
  await expect.poll(() => fixture.generationWaiters.length).toBe(1);
  const original = fixture.store.created[0]!;
  const entryA = await privateEntry(page, fixture); await expect(slider(page, "en")).toBeHidden();
  fixture.owner = ownerB; fixture.holdGeneration = false;
  await page.reload(); await ready(page, fixture, "en", targetSeq, false);
  const other = generations(fixture).find((request) => request.owner === ownerB)!;
  expect(other.requestId).not.toBe(original.requestId); expect(other.generationId).not.toBe(original.generationId);
  expect((await privateEntry(page, fixture)).usr).toEqual(entryA.usr);
  const connections = fixture.socketsOpened; await fixture.disconnect();
  await expect.poll(() => fixture.socketsOpened).toBeGreaterThan(connections);
  fixture.releaseGeneration(); await settled(fixture); await ready(page, fixture, "en");
  expect(fixture.timelineRequests.filter((request) => request.owner === ownerB).every((request) => request.generationId !== original.generationId)).toBe(true);
  await observe(page, "other-account-after-late-response");
  fixture.owner = ownerA; await page.reload(); await ready(page, fixture, "en");
  expect(generations(fixture).at(-1)).toMatchObject({ owner: ownerA, requestId: original.requestId, generationId: original.generationId, status: 200 });
  expect(fixture.store.created).toHaveLength(2); await privateEntry(page, fixture); await observe(page, "original-account-recovered");
});

test("generation waits for actual current-user resolution and stays absent after a denied account reload", async ({ page }) => {
  const fixture = await setup(page, "en", 1440); fixture.holdOwner = true;
  await page.goto(momentURL); await expect.poll(() => fixture.ownerWaiters.length).toBeGreaterThan(0);
  await expect(page.getByRole("banner", { includeHidden: true })).toBeVisible();
  expect(generations(fixture)).toEqual([]); await expect(slider(page, "en")).toBeHidden();
  fixture.releaseOwner(); await ready(page, fixture, "en");
  const count = generations(fixture).length; fixture.ownerStatus = 401;
  await page.reload(); await unavailable(page, fixture, "en", "timeline.history.accessLostTitle");
  expect(generations(fixture)).toHaveLength(count);
  await expect(page.getByRole("button", { name: text("en", "timeline.history.rebuildMoment"), exact: true })).toBeHidden();
  await observe(page, "denied-account-no-generation");
});

test("authorization loss has retry without rebuilding; a denied current resource cannot fetch bytes or alter history", async ({ page }) => {
  const fixture = await setup(page, "en", 1440, "resource"); fixture.windowStatus = 403;
  await page.goto(momentURL); await unavailable(page, fixture, "en", "timeline.history.accessLostTitle");
  const original = fixture.store.created[0]!;
  await expect(page.getByRole("button", { name: text("en", "timeline.history.rebuildMoment"), exact: true })).toBeHidden();
  fixture.windowStatus = 200;
  await page.getByTestId("timeline-error").getByRole("button", { name: text("en", "timeline.error.retry"), exact: true }).click();
  await ready(page, fixture, "en"); await openDetails(page, "en", 1440);
  fixture.detailStatus.set(resourceId, 403);
  await details(page, "en").getByRole("link", { name: text("en", "timeline.current.resource"), exact: true }).click();
  await expect(page.getByRole("dialog", { name: en.resources.unavailableTitle, exact: true }).getByRole("alert")).toBeVisible();
  await settled(fixture);
  expect(fixture.resourceRequests.filter((request) => request.kind === "sign" || request.kind === "body")).toEqual([]);
  await page.goBack(); await ready(page, fixture, "en"); expect(fixture.store.created).toEqual([original]);
  await observe(page, "denied-current-target-return");
});

for (const mode of ["server", "legacy"] as const) test(`${mode} missing exact moment never becomes its neighboring event`, async ({ page }) => {
  const fixture = await setup(page, "en", 1440); fixture.missing = mode;
  await page.goto(momentURL); await unavailable(page, fixture, "en", "timeline.history.missingMomentTitle");
  expect(new URL(page.url()).searchParams.get("at")).toBe(targetSeq);
  expect(fixture.store.created).toHaveLength(1);
  await expect(page.getByRole("link", { name: text("en", "timeline.current.card"), exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: text("en", "timeline.history.chooseMoment"), exact: true })).toBeVisible();
  await observe(page, `${mode}-exact-missing`);
});

test("malformed and out-of-range URLs remain unavailable without issuing those selectors", async ({ page }) => {
  const fixture = await setup(page, "en", 1440);
  for (const value of ["not-a-sequence", "9223372036854775808"]) {
    await page.goto(`${timelinePath}?at=${value}`); await unavailable(page, fixture, "en", "timeline.history.invalidMomentTitle");
    expect(fixture.timelineRequests.some((request) => new URLSearchParams(request.query).get("at_seq") === value)).toBe(false);
    expect(fixture.timelineRequests.filter((request) => request.kind === "window")).toEqual([]);
    expect(new URL(page.url()).searchParams.get("at")).toBe(value);
    await observe(page, `invalid-${value}`);
  }
});

test("expired same-entry reload stays expired until a deliberate Rebuild then reloads that exact new moment", async ({ page }) => {
  const fixture = await setup(page, "en", 1440);
  await page.goto(momentURL); await ready(page, fixture, "en"); const original = fixture.store.created[0]!;
  fixture.store.expired.add(original.generationId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.reload(); await unavailable(page, fixture, "en", "timeline.history.expiredTitle");
    expect(generations(fixture).at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 410 });
    expect(fixture.store.created).toHaveLength(1); expect(new URL(page.url()).searchParams.get("at")).toBe(targetSeq);
  }
  await observe(page, "sticky-expired-entry");
  await page.getByTestId("timeline-error").getByRole("button", { name: text("en", "timeline.history.rebuildMoment"), exact: true }).click();
  await ready(page, fixture, "en"); const rebuilt = fixture.store.created.at(-1)!;
  expect(rebuilt.requestId).not.toBe(original.requestId); expect(rebuilt.generationId).not.toBe(original.generationId);
  await page.reload(); await ready(page, fixture, "en");
  expect(generations(fixture).at(-1)).toMatchObject({ requestId: rebuilt.requestId, generationId: rebuilt.generationId, status: 200 });
  expect(fixture.store.created).toHaveLength(2); await privateEntry(page, fixture); await observe(page, "rebuilt-and-reloaded");
});

test("native Back reauthorizes the retained exact generation after production inactive-query GC", async ({ page }) => {
  const fixture = await setup(page, "en", 1440);
  // Root-approved control of actual scheduled timers, never QueryClient data.
  await page.clock.install(); runs.get(page)!.clock = "Playwright clock: fastForward(300001) only while timeline unmounted; not real elapsed-time evidence";
  await page.goto(momentURL); await ready(page, fixture, "en"); await flag(page, "en").fill(privateFlag); await openDetails(page, "en", 1440);
  const original = fixture.store.created[0]!, link = details(page, "en").getByRole("link", { name: text("en", "timeline.current.card"), exact: true });
  const linkId = await link.getAttribute("id"); await link.focus(); await link.press("Enter");
  await currentDestination(page, fixture, "en", "card"); const before = generations(fixture).length;
  await page.clock.fastForward(300001); await settled(fixture);
  await page.goBack(); await ready(page, fixture, "en");
  expect(generations(fixture).length).toBeGreaterThan(before);
  expect(generations(fixture).at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
  expect(fixture.store.created).toEqual([original]); await expect(flag(page, "en")).toHaveValue(privateFlag);
  await expect(details(page, "en")).toBeVisible(); await expect(page.locator(`[id="${linkId}"]`)).toBeFocused();
  await observe(page, "back-after-clock-controlled-gc");
});


test("live signals leave replay frozen while an explicit observed-board view and refresh remain separate", async ({ page }) => {
  const fixture = await setup(page, "en", 1440);
  await page.goto(momentURL); await ready(page, fixture, "en");
  const original = fixture.store.created[0]!;
  const windows = fixture.timelineRequests.filter((request) => request.kind === "window").length;
  await expect.poll(() => fixture.subscriptions.includes("activity.*")).toBe(true);
  fixture.emitActivity();
  await expect(page.getByRole("button", { name: text("en", "timeline.history.newActivity"), exact: true })).toBeVisible();
  await ready(page, fixture, "en");
  expect(fixture.store.created).toEqual([original]);
  expect(fixture.timelineRequests.filter((request) => request.kind === "window")).toHaveLength(windows);
  await page.getByRole("button", { name: text("en", "timeline.history.observedBoard"), exact: true }).click();
  await expect(page.getByTestId("replay-board").getByText(currentTitle, { exact: true })).toBeVisible();
  await expect(page.getByTestId("timeline-controls").getByRole("status")).toContainText(/observation is separate from historical replay/i);
  await expect(slider(page, "en")).toBeHidden();
  expect(fixture.timelineRequests.filter((request) => request.kind === "live")).toHaveLength(1);
  await observe(page, "explicit-current-observation");
  await page.getByRole("button", { name: text("en", "timeline.history.returnReplay"), exact: true }).click();
  await ready(page, fixture, "en");
  await expect(page.getByTestId("replay-board").getByText(historicalTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: text("en", "timeline.history.newActivity"), exact: true }).click();
  // The old replay still satisfies ready() until the refresh effect starts.
  // Wait for this refresh's completed exact window, not an idle old view.
  await expect.poll(() => fixture.timelineRequests.some((request) => request.kind === "window"
    && request.generationId !== original.generationId && request.status === 200 && request.completedAt !== undefined
    && new URLSearchParams(request.query).get("at_seq") === targetSeq
    && new URLSearchParams(request.query).get("exact") === "true")).toBe(true);
  await ready(page, fixture, "en"); expect(fixture.store.created).toHaveLength(2);
  expect(fixture.store.created[1]!.generationId).not.toBe(original.generationId);
  await privateEntry(page, fixture); await observe(page, "deliberate-refresh-after-live-signal");
});
