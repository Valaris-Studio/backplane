// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { installNavigationFixture, notePath, type NavigationFixture } from "./fixtures/uxc-navigation-fixture";
import { discoveryPath, listPath, overviewPath, retainedSessions, workspaces } from "./fixtures/a03-owner-discovery";
import { boardId, cardId, contentsPath, routePath, session, sessionId, sessionPath, sha, slug } from "./fixtures/session-window-fixture";

test.skip(process.env.BACKPLANE_E2E_INSECURE_ORIGIN_FIXTURE !== "1", "Requires explicit insecure-origin synthetic-fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce",
  viewport: { width: 1440, height: 1000 },
  launchOptions: { args: ["--host-resolver-rules=MAP backplane-insecure.test 127.0.0.1"] } });
const manifestPath = process.env.BACKPLANE_E2E_A03_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; source_manifest: unknown; files: Record<string, string> } : null;
const inputs = ["e2e/a03-insecure-origin.spec.ts", "e2e/fixtures/a03-owner-discovery.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts"];
const sources = ["src/main.tsx", "src/App.tsx", "src/providers/ReturnNavigationProvider.tsx", "src/pages/WorkspacesPage.tsx", "src/features/sessions/components/GlobalSessionsPage.tsx", "src/features/sessions/api/use-owner-sessions.ts", "src/lib/format.ts"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
type Run = { fixture: NavigationFixture; origin: string; requests: unknown[]; responses: unknown[]; pending: Promise<void>[];
  console: unknown[]; observations: unknown[]; before: ReturnType<typeof hashes>; sourceBefore: ReturnType<typeof hashes> };
const runs = new Map<Page, Run>();
const rowLinks = (page: Page) => page.locator('a[id^="owner-session-link-"]');
const errorHeading = (page: Page) => page.getByRole("heading", { name: en.pageRecovery.title, exact: true });
const selected = (page: Page) => page.locator(`#owner-session-link-${sessionId}`);

function explicitOrigin() {
  const raw = process.env.BACKPLANE_E2E_BASE_URL;
  assert(raw, "Setup: provide the explicit non-loopback HTTP preview URL");
  const url = new URL(raw);
  assert(url.protocol === "http:" && url.hostname === "backplane-insecure.test" && url.port && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password,
    "Setup: expected http://backplane-insecure.test:PORT, with no credentials or browser security overrides");
  return url.origin;
}

async function setup(page: Page) {
  const origin = explicitOrigin();
  expect(manifest, "Setup: exact frozen built-tree manifest is required").not.toBeNull();
  expect(manifest!.head).toMatch(/^[0-9a-f]{40}$/); expect(manifest!.tree).toMatch(/^[0-9a-f]{40}$/); expect(manifest!.source_manifest).toBeDefined();
  // The higher owner-discovery installer intentionally admits localhost only.
  // Reuse its metadata seeds and the unchanged lower real-reader fixture.
  const fixture = await installNavigationFixture(page, "en");
  const run: Run = { fixture, origin, requests: [], responses: [], pending: [], console: [], observations: [], before: hashes(inputs), sourceBefore: hashes(sources) };
  runs.set(page, run);
  page.on("request", (request) => run.requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), navigation: request.isNavigationRequest(), payloadSha256: request.postData() === null ? null : sha(request.postData()!), at: Date.now() }));
  page.on("console", (message) => { if (message.type() === "error") run.console.push({ text: message.text(), location: message.location() }); });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") && !response.request().isNavigationRequest()) return;
    run.pending.push(response.body().then((bytes) => { run.responses.push({ url: response.url(), status: response.status(), bytes: bytes.length, sha256: sha(bytes),
      ...(response.status() !== 200 ? { diagnostic: bytes.toString().slice(0, 1500) } : {}) }); }).catch((error: unknown) => { run.responses.push({ url: response.url(), unreadable: String(error) }); }));
  });
  const rows = retainedSessions();
  const inherited = new Set(["/api/auth/modes", "/api/auth/setup-status", "/api/me", "/api/notifications", "/api/notifications/unread-count", "/api/me/companion/installations",
    `/api/workspaces/${slug}`, `/api/workspaces/${slug}/members`, `/api/workspaces/${slug}/boards`, `/api/workspaces/${slug}/boards/${boardId}`,
    `/api/workspaces/${slug}/boards/${boardId}/cards`, `/api/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
    `/api/workspaces/${slug}/approvals`, `/api/workspaces/${slug}/notifications`, `/api/workspaces/${slug}/notifications/unread-count`, `/api/workspaces/${slug}/sessions/summary`,
    sessionPath, `${sessionPath}/calls`, `${sessionPath}/links`, `${sessionPath}/children`, `${sessionPath}/usage`, `${sessionPath}/rhythm`, `${contentsPath}/window`, notePath]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === "GET" && inherited.has(path)) return route.fallback();
    if (request.method() === "POST" && path === `${contentsPath}/metadata`) return route.fallback();
    fixture.inflight += 1;
    try {
      assert(url.origin === origin && request.method() === "GET" && [listPath, overviewPath, "/api/workspaces"].includes(path), `Unexpected insecure-origin API: ${request.method()} ${url.href}`);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests have no credentials");
      let value: unknown;
      if (path === "/api/workspaces") value = workspaces;
      else if (path === overviewPath) {
        assert.deepEqual([...url.searchParams.keys()].sort(), ["active_limit", "recent_limit"]);
        assert.equal(url.searchParams.get("active_limit"), "6"); assert.equal(url.searchParams.get("recent_limit"), "6");
        value = { active: rows.slice(0, 6).map((row) => ({ ...row, status: "active", display_state: "active", ended_at: null, ended_reason: null })), recent: rows.slice(6, 12), active_more: true, recent_more: true, generated_at: session.started_at };
      } else {
        assert([...url.searchParams.keys()].every((key) => ["root_only", "limit", "sort", "q"].includes(key)), "Only this bounded no-pagination discovery scope is supported");
        assert.equal(url.searchParams.get("limit"), "40"); assert.equal(url.searchParams.get("root_only"), "true");
        assert.equal(url.searchParams.get("sort") ?? "recent", "recent");
        const query = url.searchParams.get("q") ?? "";
        assert(query === "" || query === session.title, "Only the deliberate private-title query is supported");
        const matching = query ? rows.filter((row) => row.title === query) : rows;
        value = { items: matching.slice(0, 40), next_cursor: matching.length > 40 ? "unused-insecure-origin-cursor" : null };
      }
      fixture.requests.push({ path, query: url.search, method: request.method(), mode: null, callId: null, cursor: null, status: 200, bytes: Buffer.byteLength(JSON.stringify(value)), startedAt: Date.now() });
      await route.fulfill({ status: 200, json: value });
    } catch (error) {
      fixture.unexpected.push(String(error)); await route.fulfill({ status: 418, json: { detail: "Outside the insecure-origin synthetic fixture" } });
    } finally { fixture.inflight -= 1; }
  });
  // Admit exactly the requested non-loopback document/assets; APIs still pass
  // through the strict synthetic allowlist. Never rewrite a URL to localhost.
  await page.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.headers().authorization || request.headers().cookie) {
      fixture.unexpected.push(`Unexpected origin or credentials: ${request.method()} ${url.href}`); return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/")) return route.fallback();
    if (request.method() === "GET" && ((request.isNavigationRequest() && ["/", discoveryPath, routePath].includes(url.pathname)) || Object.hasOwn(manifest!.files, url.pathname.slice(1)))) return route.continue();
    fixture.unexpected.push(`Unexpected non-API request: ${request.method()} ${url.href}`); return route.abort("blockedbyclient");
  });
  await page.routeWebSocket("**", async (socket) => {
    const url = new URL(socket.url());
    if (url.protocol !== "ws:" || url.host !== new URL(origin).host || url.pathname !== `/ws/workspaces/${slug}/events` || url.search) {
      fixture.unexpected.push(`Unexpected socket: ${url.href}`); await socket.close({ code: 1008, reason: "Outside exact insecure-origin fixture" }); return;
    }
    fixture.socket = socket; fixture.socketsOpened += 1; fixture.subscriptions = [];
    const connection = fixture.socketsOpened; fixture.socketLedger.push({ kind: "connected", at: Date.now(), connection });
    socket.onMessage((message) => { const frame = JSON.parse(String(message)); if (Array.isArray(frame.subscribe)) {
      fixture.subscriptions = frame.subscribe; fixture.socketLedger.push({ kind: "subscribe", at: Date.now(), connection, payload: frame.subscribe });
    } });
  });
  return run;
}

async function insecureDocument(page: Page, path: string) {
  const response = await page.goto(path), run = runs.get(page)!;
  const capabilities = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle, getRandomValues: typeof crypto.getRandomValues }));
  run.observations.push({ kind: "document-precondition", url: page.url(), status: response?.status(), capabilities });
  expect(response?.status(), "Setup: the explicitly allowed host must serve the actual built HTML").toBe(200);
  expect(capabilities).toEqual({ origin: run.origin, secure: false, randomUUID: "undefined", subtle: "undefined", getRandomValues: "function" });
}
async function healthy(page: Page, target: Locator) {
  await expect(target.or(errorHeading(page))).toBeVisible();
  await expect(errorHeading(page), "A supported plain-HTTP route must not enter page recovery").toHaveCount(0);
  await expect(target).toBeVisible();
}
async function settle(run: Run) { await expect.poll(() => run.fixture.inflight).toBe(0); expect(run.fixture.unexpected).toEqual([]); }
async function observe(page: Page, name: string) {
  runs.get(page)!.observations.push({ name, ...await page.evaluate(() => ({ url: location.href, history: history.state, focus: document.activeElement?.id, scrollY,
    local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) })) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  run.fixture.release();
  let finalError: string | null = null;
  try { await observe(page, "final-insecure-shell"); } catch (error) { finalError = String(error); }
  await Promise.all([...run.pending, ...run.fixture.pendingAssets]);
  const assets = run.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.slice(1)] }));
  const after = hashes(inputs), sourceAfter = hashes(sources);
  const output = info.outputPath("a03-insecure-origin-ledger.json");
  writeFileSync(output, JSON.stringify({ scope: "Actual built AppShell on an untrusted plain-HTTP origin; synthetic HTTP/WS, not live authorization", status: info.status,
    browser: page.context().browser()?.version(), origin: run.origin, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), manifest,
    inputsBefore: run.before, inputsAfter: after, currentSourceBefore: run.sourceBefore, currentSourceAfter: sourceAfter, requests: run.requests, responses: run.responses,
    fixtureRequests: run.fixture.requests, socket: run.fixture.socketLedger, failures: run.fixture.failures, unexpected: run.fixture.unexpected,
    console: run.console, observations: run.observations, assets, finalError }, null, 2));
  await info.attach("a03-insecure-origin-ledger", { path: output, contentType: "application/json" });
  expect.soft(after).toEqual(run.before); expect.soft(sourceAfter).toEqual(run.sourceBefore); expect.soft(finalError).toBeNull();
  expect.soft(run.fixture.unexpected).toEqual([]); expect.soft(run.console).toEqual([]);
  expect.soft(run.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(assets.some((asset) => asset.path.endsWith(".js"))).toBe(true); expect.soft(assets.some((asset) => asset.path.endsWith(".css"))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  runs.delete(page);
});

test("plain-HTTP Home and global owner discovery render without a secure-context UUID dependency", async ({ page }) => {
  const run = await setup(page); await insecureDocument(page, "/");
  const home = page.getByRole("region", { name: en.sessions.discovery.title, exact: true });
  await healthy(page, home); await expect(home.getByRole("region", { name: en.sessions.discovery.active, exact: true }).locator("li")).toHaveCount(6);
  await expect(home.getByRole("region", { name: en.sessions.discovery.recent, exact: true }).locator("li")).toHaveCount(6);
  await settle(run); await observe(page, "home-on-insecure-origin");
  await home.getByRole("link", { name: en.sessions.discovery.viewAll, exact: true }).click();
  await healthy(page, page.getByRole("heading", { name: en.sessions.discovery.allSessions, exact: true }));
  await expect(rowLinks(page)).toHaveCount(40); await settle(run);
  expect(run.fixture.requests.filter((request) => request.path.startsWith(sessionPath))).toEqual([]);
  expect(run.fixture.socketsOpened).toBe(0);
  await observe(page, "global-on-insecure-origin");
});

test("plain-HTTP global context link and Return preserve private filter, exact selection and focus without serializing private origin", async ({ page }) => {
  const run = await setup(page), privateQuery = session.title!;
  const originPath = `${discoveryPath}?${new URLSearchParams({ q: privateQuery, root_only: "true" })}`;
  await insecureDocument(page, originPath);
  await healthy(page, page.getByRole("heading", { name: en.sessions.discovery.allSessions, exact: true }));
  await expect(rowLinks(page)).toHaveCount(1); await expect(selected(page)).toHaveText(privateQuery); await settle(run);
  const search = page.getByRole("textbox", { name: en.sessions.filters.search, exact: true });
  await expect(search).toHaveValue(privateQuery); await selected(page).focus(); await selected(page).press("Enter");
  await healthy(page, page.getByRole("heading", { name: session.title!, exact: true }));
  expect(new URL(page.url()).pathname).toBe(routePath); expect(new URL(page.url()).search).toBe("");
  const usr = await page.evaluate(() => history.state?.usr);
  expect(usr?.bpReturn?.originKey).toMatch(/^[0-9a-f-]{36}$/i);
  const persisted = JSON.stringify(await page.evaluate(() => ({ usr: history.state?.usr, local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) })));
  for (const privateValue of [privateQuery, originPath, workspaces[0]!.name, "SYNTHETIC COMPLETE RECORD"]) expect(persisted).not.toContain(privateValue);
  await page.getByRole("tab", { name: en.sessions.contents.title, exact: true }).click();
  await expect(page.locator("#content-20000000-0000-4000-8000-000000010001")).toBeAttached(); await settle(run);
  expect(run.fixture.requests.filter((request) => /\/(body|download)$/.test(request.path))).toEqual([]);
  await observe(page, "reader-opaque-return-state");
  await page.getByRole("link", { name: en.navigation.returnToPrevious, exact: true }).click();
  await healthy(page, page.getByRole("heading", { name: en.sessions.discovery.allSessions, exact: true }));
  await expect(search).toHaveValue(privateQuery); await expect(selected(page)).toBeFocused(); await expect(rowLinks(page)).toHaveCount(1);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(originPath);
  await settle(run); await observe(page, "private-filter-restored-in-memory");
});
