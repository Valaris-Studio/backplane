// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { boardId, slug, installTimelineFixture, momentURL, ownerA, ownerB, privateFlag, privateSearch, targetSeq, targetSummary,
  historicalTitle, actorName, sha, timelineApi, timelinePath, type TimelineFixture } from "./fixtures/a05-timeline-navigation";

test.skip(process.env.BACKPLANE_E2E_INSECURE_ORIGIN_FIXTURE !== "1", "Requires explicit insecure-origin synthetic-fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce",
  viewport: { width: 1440, height: 1000 },
  launchOptions: { args: ["--host-resolver-rules=MAP backplane-insecure.test 127.0.0.1"] } });
const manifestPath = process.env.BACKPLANE_E2E_A05_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; source_manifest: unknown; files: Record<string, string> } : null;
const inputs = ["e2e/a05-insecure-origin.spec.ts", "e2e/fixtures/a05-timeline-navigation.ts", "e2e/fixtures/a06-resource-destination.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts"];
const sources = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/features/timeline/api/use-timeline-history.ts", "src/features/timeline/utils/timeline-entry.ts", "src/features/timeline/components/TimelineSimulator.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
type Participant = { page: Page; fixture: TimelineFixture; ownedContext?: BrowserContext };
type Run = { origin: string; participants: Participant[]; requests: unknown[]; responses: unknown[]; pending: Promise<void>[];
  console: unknown[]; observations: unknown[]; before: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes> };
const runs = new Map<Page, Run>();
const generationReads = (fixture: TimelineFixture) => fixture.timelineRequests.filter((request) => request.kind === "generation");
const slider = (page: Page) => page.getByRole("slider", { name: en.timeline.scrubber.label, exact: true });
const errorHeading = (page: Page) => page.getByRole("heading", { name: en.pageRecovery.title, exact: true });

function explicitOrigin() {
  const raw = process.env.BACKPLANE_E2E_BASE_URL;
  assert(raw, "Setup: provide the explicit non-loopback HTTP preview URL");
  const url = new URL(raw);
  assert(url.protocol === "http:" && url.hostname === "backplane-insecure.test" && url.port && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password,
    "Setup: expected http://backplane-insecure.test:PORT with no credentials or browser security overrides");
  return url.origin;
}

async function registerParticipant(run: Run, page: Page, fixture: TimelineFixture, ownedContext?: BrowserContext) {
  run.participants.push({ page, fixture, ownedContext });
  const index = run.participants.length - 1;
  page.on("request", (request) => run.requests.push({ page: index, url: request.url(), method: request.method(), type: request.resourceType(), navigation: request.isNavigationRequest(), payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }));
  page.on("console", (message) => { if (message.type() === "error") run.console.push({ page: index, text: message.text(), location: message.location() }); });
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.startsWith("/api/") && !response.request().isNavigationRequest()) return;
    run.pending.push(response.body().then((bytes) => { run.responses.push({ page: index, url: response.url(), status: response.status(), bytes: bytes.length, sha256: sha(bytes),
      ...(response.status() >= 400 ? { diagnostic: bytes.toString().slice(0, 1500) } : {}) }); }).catch((error: unknown) => { run.responses.push({ page: index, url: response.url(), unreadable: String(error) }); }));
  });
  // The API installer already accepts the actual same-origin URL. Override
  // only inherited localhost transport guards, without rewriting any URL.
  await page.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== run.origin || request.headers().authorization || request.headers().cookie) {
      fixture.unexpected.push(`Unexpected origin or credentials: ${request.method()} ${url.href}`); return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/")) return route.fallback();
    if (request.method() === "GET" && ((request.isNavigationRequest() && url.pathname === timelinePath) || Object.hasOwn(manifest!.files, url.pathname.slice(1)))) return route.continue();
    fixture.unexpected.push(`Unexpected non-API request: ${request.method()} ${url.href}`); return route.abort("blockedbyclient");
  });
  await page.routeWebSocket("**", async (socket) => {
    const url = new URL(socket.url());
    if (url.protocol !== "ws:" || url.host !== new URL(run.origin).host || url.pathname !== `/ws/workspaces/${slug}/events` || url.search) {
      fixture.unexpected.push(`Unexpected socket: ${url.href}`); await socket.close({ code: 1008, reason: "Outside exact insecure-origin fixture" }); return;
    }
    fixture.socket = socket; fixture.socketsOpened += 1; fixture.subscriptions = [];
    const connection = fixture.socketsOpened; fixture.socketLedger.push({ kind: "connected", at: Date.now(), connection });
    socket.onMessage((message) => { const frame = JSON.parse(String(message)); if (Array.isArray(frame.subscribe)) {
      fixture.subscriptions = frame.subscribe; fixture.socketLedger.push({ kind: "subscribe", at: Date.now(), connection, payload: frame.subscribe });
    } });
  });
}
async function setup(page: Page) {
  const origin = explicitOrigin();
  expect(manifest, "Setup: exact frozen built-tree manifest is required").not.toBeNull();
  expect(manifest!.head).toMatch(/^[0-9a-f]{40}$/); expect(manifest!.tree).toMatch(/^[0-9a-f]{40}$/); expect(manifest!.source_manifest).toBeDefined();
  const run: Run = { origin, participants: [], requests: [], responses: [], pending: [], console: [], observations: [], before: hashes(inputs), sourceBefore: hashes(sources) };
  runs.set(page, run);
  const fixture = await installTimelineFixture(page, "en"); await registerParticipant(run, page, fixture);
  return { run, fixture };
}
async function insecureDocument(page: Page, run: Run, action: "open" | "reload") {
  const response = action === "reload" ? await page.reload() : await page.goto(new URL(momentURL, run.origin).href);
  const capabilities = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle, getRandomValues: typeof crypto.getRandomValues }));
  run.observations.push({ kind: "document-precondition", action, url: page.url(), status: response?.status(), capabilities });
  expect(response?.status(), "Setup: explicitly allowed host must serve the actual built HTML").toBe(200);
  expect(capabilities).toEqual({ origin: run.origin, secure: false, randomUUID: "undefined", subtle: "undefined", getRandomValues: "function" });
}
async function ready(page: Page, fixture: TimelineFixture) {
  const timelineError = page.getByTestId("timeline-error");
  await expect(slider(page).or(errorHeading(page)).or(timelineError)).toBeVisible();
  await expect(errorHeading(page), "Supported plain HTTP must not enter page recovery").toHaveCount(0);
  await expect(timelineError, "Supported plain HTTP must derive the authorized replay identity").toHaveCount(0);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", new RegExp(targetSummary));
  expect(new URL(page.url()).search).toBe(`?at=${targetSeq}`);
  await expect.poll(() => fixture.inflight).toBe(0); expect(fixture.unexpected).toEqual([]);
}

// Independent native Node SHA-256 oracle for the already accepted versioned
// identity format; no browser crypto function or application module is replaced.
function expectedRequest(nonce: string, owner: string) {
  const bytes = createHash("sha256").update(JSON.stringify(["bp.timeline.request.v1", nonce, owner, slug, boardId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function privateIdentity(page: Page, fixture: TimelineFixture, owner: string) {
  const observed = await page.evaluate(() => ({ url: location.href, usr: history.state?.usr,
    local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) }));
  expect(observed.usr?.bpTimeline).toEqual({ v: 1, n: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
  const nonce = observed.usr.bpTimeline.n as string;
  const request = generationReads(fixture).at(-1)!;
  expect(request.owner).toBe(owner); expect(request.requestId).toBe(expectedRequest(nonce, owner));
  const serialized = JSON.stringify({ usr: observed.usr, local: observed.local, session: observed.session });
  for (const forbidden of [ownerA, ownerB, privateFlag, privateSearch, historicalTitle, actorName, targetSeq,
    ...fixture.store.created.flatMap((item) => [item.requestId, item.generationId])]) {
    expect(serialized).not.toContain(forbidden);
    if (forbidden !== targetSeq) expect(observed.url).not.toContain(forbidden);
  }
  expect(serialized).not.toContain("events");
  return { nonce, usr: observed.usr, request };
}
async function observe(page: Page, run: Run, name: string) {
  run.observations.push({ name, ...await page.evaluate(() => ({ url: location.href, history: history.state, focusedId: document.activeElement?.id,
    local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) })) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  try {
    for (const { fixture } of run.participants) fixture.releaseTimeline();
    let finalError: string | null = null;
    try { await observe(page, run, "final-insecure-shell"); } catch (error) { finalError = String(error); }
    await Promise.all([...run.pending, ...run.participants.flatMap(({ fixture }) => fixture.pendingAssets)]);
    const assets = run.participants.flatMap(({ fixture }, index) => fixture.assets.map((asset) => ({ ...asset, page: index, expected: manifest?.files[asset.path.slice(1)] })));
    const after = hashes(inputs), sourceAfter = hashes(sources), output = info.outputPath("a05-insecure-origin-ledger.json");
    writeFileSync(output, JSON.stringify({ scope: "Actual built AppShell on an untrusted plain-HTTP origin; synthetic authorized HTTP/WS, not live server authorization", status: info.status,
      browser: page.context().browser()?.version(), origin: run.origin, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), manifest,
      inputsBefore: run.before, inputsAfter: after, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter,
      requests: run.requests, responses: run.responses, console: run.console, observations: run.observations, assets, finalError,
      participants: run.participants.map(({ fixture }) => ({ requests: fixture.requests, timeline: fixture.timelineRequests, generations: fixture.store.created,
        socket: fixture.socketLedger, unexpected: fixture.unexpected, failures: fixture.failures })) }, null, 2));
    await info.attach("a05-insecure-origin-ledger", { path: output, contentType: "application/json" });
    expect.soft(after).toEqual(run.before); expect.soft(sourceAfter).toEqual(run.sourceBefore); expect.soft(finalError).toBeNull(); expect.soft(run.console).toEqual([]);
    for (const { fixture } of run.participants) {
      expect.soft(fixture.unexpected).toEqual([]);
      expect.soft(fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED") || !failure.startsWith(timelineApi))).toEqual([]);
    }
    expect.soft(assets.some((asset) => asset.path.endsWith(".js"))).toBe(true); expect.soft(assets.some((asset) => asset.path.endsWith(".css"))).toBe(true);
    expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  } finally {
    await Promise.all(run.participants.map(({ ownedContext }) => ownedContext?.close())); runs.delete(page);
  }
});

test("plain HTTP derives the exact SHA-256-bound replay identity and hard reload keeps its authorized generation", async ({ page }) => {
  const { run, fixture } = await setup(page); await insecureDocument(page, run, "open"); await ready(page, fixture);
  await page.getByRole("searchbox", { name: en.timeline.history.localSearch, exact: true }).fill(privateFlag);
  const before = await privateIdentity(page, fixture, ownerA), generation = fixture.store.created[0]!;
  expect(before.request.status).toBe(201); await observe(page, run, "before-insecure-hard-reload");
  await insecureDocument(page, run, "reload"); await ready(page, fixture);
  const after = await privateIdentity(page, fixture, ownerA);
  await expect(page.getByRole("searchbox", { name: en.timeline.history.localSearch, exact: true })).toHaveValue("");
  expect(after.usr).toEqual(before.usr); expect(after.request).toMatchObject({ requestId: generation.requestId, generationId: generation.generationId, status: 200 });
  expect(fixture.store.created).toEqual([generation]); await observe(page, run, "after-insecure-hard-reload");
});

test("plain HTTP isolates A→B→A at one entry and a copied URL without persisting owner or generation data", async ({ page, browser }) => {
  const { run, fixture } = await setup(page); await insecureDocument(page, run, "open"); await ready(page, fixture);
  const first = await privateIdentity(page, fixture, ownerA), original = fixture.store.created[0]!;
  fixture.owner = ownerB; await insecureDocument(page, run, "reload"); await ready(page, fixture);
  const second = await privateIdentity(page, fixture, ownerB);
  expect(second.usr).toEqual(first.usr); expect(second.request.requestId).not.toBe(original.requestId); expect(second.request.generationId).not.toBe(original.generationId);
  expect(fixture.timelineRequests.filter((request) => request.owner === ownerB).every((request) => request.generationId !== original.generationId)).toBe(true);
  fixture.owner = ownerA; await insecureDocument(page, run, "reload"); await ready(page, fixture);
  const recovered = await privateIdentity(page, fixture, ownerA);
  expect(recovered.usr).toEqual(first.usr); expect(recovered.request).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
  expect(fixture.store.created).toHaveLength(2);
  const context = await browser.newContext({ baseURL: run.origin, storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const child = await context.newPage();
  const other = await installTimelineFixture(child, "en", { owner: ownerB, store: fixture.store });
  await registerParticipant(run, child, other, context);
  await insecureDocument(child, run, "open"); await ready(child, other);
  const copied = await privateIdentity(child, other, ownerB);
  expect(copied.nonce).not.toBe(first.nonce); expect(copied.request.requestId).not.toBe(second.request.requestId);
  expect(copied.request.generationId).not.toBe(original.generationId); expect(copied.request.generationId).not.toBe(second.request.generationId);
  expect(await child.evaluate(() => history.state?.usr?.bpReturn ?? null)).toBeNull();
  expect(fixture.store.created).toHaveLength(3); await observe(child, run, "copied-insecure-context"); await observe(page, run, "original-account-still-restored");
});
