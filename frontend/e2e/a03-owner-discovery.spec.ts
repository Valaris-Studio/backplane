// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { contentId, routePath, session, sessionId, sessionPath, sha, windowRequests } from "./fixtures/session-window-fixture";
import { noteHref, originalNoteTitle } from "./fixtures/uxc-navigation-fixture";
import { discoveryPath, installOwnerDiscoveryFixture, listPath, overviewPath, workspaces, type OwnerDiscoveryFixture } from "./fixtures/a03-owner-discovery";

test.skip(process.env.BACKPLANE_E2E_A03_OWNER_FIXTURE !== "1", "Requires synthetic A03 built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

const labelsByLocale = { en, es, "pt-BR": pt };
type Locale = keyof typeof labelsByLocale;
const inputFiles = ["e2e/a03-owner-discovery.spec.ts", "e2e/fixtures/a03-owner-discovery.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts",
  "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const productionFiles = ["src/App.tsx", "src/pages/WorkspacesPage.tsx", "src/features/sessions/components/GlobalSessionsPage.tsx",
  "src/features/sessions/components/OwnerSessionOverview.tsx", "src/features/sessions/components/OwnerSessionRow.tsx",
  "src/features/sessions/components/OwnerSessionCompactRow.tsx",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/sessions/hooks/use-owner-session-snapshot.ts",
  "src/features/sessions/hooks/use-owner-session-filters.ts", "src/features/sessions/owner-session-authority.ts",
  "src/features/workspaces/api/use-workspaces.ts", "src/features/notifications/api/use-current-user.ts",
  "src/providers/ReturnNavigationProvider.tsx", "src/providers/WebSocketProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/features/sessions/components/SessionDetailPage.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A03_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; tree: string; source_manifest: unknown; files: Record<string, string>;
} : null;
const states = new Map<Page, { fixture: OwnerDiscoveryFixture; inputsBefore: ReturnType<typeof hashes>;
  sourceBefore: ReturnType<typeof hashes>; observations: unknown[] }>();
const rowLinks = (page: Page) => page.locator('a[id^="owner-session-link-"]');
const rowIds = (page: Page) => rowLinks(page).evaluateAll((links) => links.map((link) => link.id.replace("owner-session-link-", "")));
const selected = (page: Page) => page.locator(`#owner-session-link-${sessionId}`);
const listReads = (state: OwnerDiscoveryFixture) => state.discoveryReads.filter((read) => read.path === listPath);
const routeIdentity = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function settle(state: OwnerDiscoveryFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  await Promise.all(state.pendingResponses);
  expect(state.unexpected).toEqual([]);
}
async function observation(page: Page, name: string) {
  const state = states.get(page)!;
  state.observations.push({ name, at: Date.now(), route: routeIdentity(page), rows: await rowIds(page),
    focusAndPosition: await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"), scrollY, viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      touchPoints: navigator.maxTouchPoints, focusedTop: document.activeElement?.getBoundingClientRect().top })) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}
async function setup(page: Page, locale: Locale, width: number, path: string) {
  expect(manifest, "Supply the exact frozen build asset manifest").not.toBeNull();
  expect(manifest!.head).toMatch(/^[a-f0-9]{40}$/);
  expect(manifest!.tree).toMatch(/^[a-f0-9]{40}$/);
  expect(manifest!.source_manifest).toBeDefined();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installOwnerDiscoveryFixture(page, locale);
  states.set(page, { fixture, inputsBefore: hashes(inputFiles), sourceBefore: hashes(productionFiles), observations: [] });
  await page.goto(path);
  return fixture;
}
async function assertDiscoveryOnly(state: OwnerDiscoveryFixture) {
  await settle(state);
  expect(state.requests.filter((read) => /\/workspaces\/[^/]+\/sessions(?:\/|$)/.test(read.path))).toEqual([]);
  expect(state.requests.filter((read) => /\/(notes|cards)(?:\/|$)/.test(read.path))).toEqual([]);
  expect(state.socketsOpened).toBe(0);
  expect(state.socketLedger).toEqual([]);
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}
async function filteredReady(page: Page, state: OwnerDiscoveryFixture, query: string) {
  await expect.poll(() => listReads(state).some((read) => new URLSearchParams(read.query).get("q") === query && read.completedAt !== undefined && read.status === 200)).toBe(true);
  await settle(state);
  await expect(page.getByRole("textbox", { name: labelsByLocale.en.sessions.filters.search, exact: true })).toHaveValue(query);
}

test.afterEach(async ({ page }, info) => {
  const run = states.get(page);
  if (!run) return;
  const state = run.fixture;
  state.releaseDiscovery(); state.release();
  await Promise.all([...state.pendingAssets, ...state.pendingResponses]);
  let finalObservationError: string | null = null;
  if (!page.isClosed()) {
    try { await observation(page, "final-shell"); }
    catch (error) { finalObservationError = String(error); }
  }
  const actualAssets = state.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] }));
  const inputsAfter = hashes(inputFiles), sourceAfter = hashes(productionFiles);
  const consoleUnexpected = state.consoleEntries.filter((entry) => {
    if (!/Failed to load resource: the server responded with a status of (401|403|404|503)/.test(entry.text)) return true;
    try { return !state.discoveryReads.some((read) => read.path === new URL(entry.url).pathname && read.status !== undefined && [401, 403, 404, 503].includes(read.status)); }
    catch { return true; }
  });
  const output = info.outputPath("owner-discovery-ledger.json");
  writeFileSync(output, JSON.stringify({
    scope: "Actual built AppShell with synthetic authorized HTTP and the inherited reader socket. No deployed authorization, backfill, release or human acceptance claim.",
    browser: page.context().browser()?.version(), viewport: page.viewportSize(),
    manifestPath, manifestSha256: manifestBytes ? sha(manifestBytes) : null, artifact: manifest,
    inputsBefore: run.inputsBefore, inputsAfter, authoringSourceBefore: run.sourceBefore, authoringSourceAfter: sourceAfter,
    builtAssets: actualAssets, requests: state.requests, discoveryReads: state.discoveryReads, responses: state.apiResponses,
    sockets: state.socketLedger, consoleErrors: state.consoleEntries, consoleUnexpected, unexpected: state.unexpected,
    failures: state.failures, observations: run.observations, finalObservationError,
  }, null, 2));
  await info.attach("owner-discovery-ledger", { path: output, contentType: "application/json" });
  expect.soft(inputsAfter).toEqual(run.inputsBefore);
  expect.soft(finalObservationError).toBeNull();
  expect.soft(sourceAfter).toEqual(run.sourceBefore);
  expect.soft(state.unexpected).toEqual([]);
  expect.soft(consoleUnexpected).toEqual([]);
  expect.soft(state.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(actualAssets.some((asset) => asset.path.endsWith(".js"))).toBe(true);
  expect.soft(actualAssets.some((asset) => asset.path.endsWith(".css"))).toBe(true);
  expect.soft(actualAssets.every((asset) => asset.status === 200 && asset.expected === asset.sha256)).toBe(true);
  expect.soft(state.apiResponses.filter((response) => response.unreadable && !state.failures.some((failure) => failure.startsWith(`${response.path} `) && failure.endsWith("net::ERR_ABORTED")))).toEqual([]);
  states.delete(page);
});

for (const locale of ["en", "es", "pt-BR"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${locale} ${width} owner discovery`, () => {
      test.use({ hasTouch: width === 390 });
      test("Home → globally filtered 80 rows → actual reader → retained position", async ({ page }) => {
        const state = await setup(page, locale, width, "/"), labels = labelsByLocale[locale];
        const home = page.getByRole("region", { name: labels.sessions.discovery.title, exact: true });
        await expect(home).toHaveAccessibleDescription(labels.sessions.discovery.description);
        await expect(home.locator('li[id^="owner-session-"]')).toHaveCount(3);
        await expect(home.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveCount(0);
        await activate(home.locator('button[aria-expanded="false"]'), width);
        await expect(home.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveAttribute("href", noteHref);
        for (const workspace of workspaces) await expect(home.getByRole("link", { name: workspace.name, exact: true }).first()).toBeVisible();
        await assertDiscoveryOnly(state);
        expect(state.discoveryReads.filter((read) => read.path === overviewPath)).toHaveLength(1);
        expect(listReads(state)).toEqual([]);
        await assertNoOverflow(page); await observation(page, "home-two-workspaces");
        await activate(home.getByRole("link", { name: labels.sessions.discovery.viewAll, exact: true }), width);
        await expect(page.getByRole("heading", { name: labels.sessions.discovery.allSessions, exact: true })).toBeVisible();
        await expect(rowLinks(page)).toHaveCount(40);
        const search = page.getByRole("textbox", { name: labels.sessions.filters.search, exact: true });
        await search.fill("evidence");
        await activate(page.getByLabel(labels.sessions.filters.sort, { exact: true }), width);
        await activate(page.getByRole("option", { name: labels.sessions.filters.sorts.started, exact: true }), width);
        await activate(page.locator("summary").filter({ hasText: labels.sessions.filters.label }), width);
        for (const name of [labels.sessions.states.ended, labels.sessions.states.incomplete]) {
          const checkbox = page.getByRole("checkbox", { name, exact: true });
          // Router transitions commit the controlled state after the native click returns.
          await activate(checkbox, width);
          await expect(checkbox).toBeChecked();
        }
        const finalFilter = (query: string) => {
          const params = new URLSearchParams(query);
          return params.get("q") === "evidence" && params.get("sort") === "started" && params.getAll("state").length === 2;
        };
        await expect.poll(() => listReads(state).some((read) => finalFilter(read.query) && read.completedAt !== undefined)).toBe(true);
        await expect(rowLinks(page)).toHaveCount(40); await settle(state);
        await expect(selected(page)).toHaveCount(0);
        await activate(page.getByRole("button", { name: labels.sessions.list.loadMore, exact: true }), width);
        await expect(rowLinks(page)).toHaveCount(80); await settle(state);
        const order = await rowIds(page);
        expect(order).toEqual(state.rows.slice(0, 80).map((row) => row.id));
        const paged = listReads(state).filter((read) => finalFilter(read.query));
        expect(paged).toHaveLength(2);
        expect(paged[0]!.cursor).toBeNull();
        expect(paged[1]!.cursor).toBe((paged[0]!.response as { next_cursor: string }).next_cursor);
        expect(paged.every((read) => !new URLSearchParams(read.query).has("workspace_id") && !new URLSearchParams(read.query).has("since") && read.returned === 40)).toBe(true);
        expect(new Set(state.rows.slice(0, 80).map((row) => row.workspace_id)).size).toBe(2);
        await assertDiscoveryOnly(state); await assertNoOverflow(page);
        await selected(page).scrollIntoViewIfNeeded(); await selected(page).focus(); await frames(page);
        const departureTop = await selected(page).evaluate((link) => link.getBoundingClientRect().top);
        const departureRoute = routeIdentity(page);
        await expect(selected(page)).toBeFocused(); await expect(selected(page)).toHaveAttribute("href", routePath);
        await observation(page, "global-80-before-reader");
        if (width === 390) await selected(page).tap(); else await selected(page).press("Enter");
        await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
        expect(routeIdentity(page)).toBe(routePath);
        expect(new URL(page.url()).search).toBe("");
        await activate(page.getByRole("tab", { name: labels.sessions.contents.title, exact: true }), width);
        await expect(page.getByRole("region", { name: labels.sessions.contents.title, exact: true })).toBeVisible();
        await expect(page.locator(`#content-${contentId(10001)}`)).toBeAttached(); await settle(state);
        expect(state.requests.some((read) => read.path === sessionPath && read.status === 200)).toBe(true);
        expect(windowRequests(state).some((read) => read.status === 200 && (read.returned ?? 0) > 0)).toBe(true);
        await observation(page, "actual-reader");
        if (width === 390) await page.goBack();
        else await page.getByRole("link", { name: labels.navigation.returnToPrevious, exact: true }).click();
        await expect.poll(() => routeIdentity(page)).toBe(departureRoute);
        await expect(rowLinks(page)).toHaveCount(80); await expect(selected(page)).toBeFocused();
        expect(await rowIds(page)).toEqual(order);
        await expect(search).toHaveValue("evidence");
        await expect(page.getByRole("checkbox", { name: labels.sessions.states.ended, exact: true })).toBeChecked();
        await expect(page.getByRole("checkbox", { name: labels.sessions.states.incomplete, exact: true })).toBeChecked();
        await expect(page.getByLabel(labels.sessions.filters.sort, { exact: true })).toHaveText(labels.sessions.filters.sorts.started);
        await expect.poll(async () => Math.abs(await selected(page).evaluate((link) => link.getBoundingClientRect().top) - departureTop)).toBeLessThanOrEqual(8);
        await settle(state);
        expect(listReads(state).filter((read) => finalFilter(read.query)).every((read) => !read.ids?.includes(state.rows[80]!.id))).toBe(true);
        await assertNoOverflow(page); await observation(page, "global-80-after-return");
      });
    });
  }
}

test.describe("bounded global freshness and privacy", () => {
  test.use({ hasTouch: true });
  test("reload restores URL filters and all-workspace scope without a return-memory promise", async ({ page }) => {
    const query = new URLSearchParams({ q: "evidence", sort: "started", root_only: "true" });
    query.append("state", "ended"); query.append("state", "incomplete");
    const state = await setup(page, "en", 390, `${discoveryPath}?${query}`);
    await expect(rowLinks(page)).toHaveCount(40); await settle(state);
    const before = routeIdentity(page), first = await rowIds(page), from = listReads(state).length;
    await observation(page, "before-explicit-reload");
    await page.reload(); await expect(rowLinks(page)).toHaveCount(40); await settle(state);
    expect(routeIdentity(page)).toBe(before); expect(await rowIds(page)).toEqual(first);
    await expect(page.getByRole("textbox", { name: en.sessions.filters.search, exact: true })).toHaveValue("evidence");
    await expect(page.getByRole("checkbox", { name: en.sessions.states.ended, exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: en.sessions.states.incomplete, exact: true })).toBeChecked();
    expect(listReads(state).slice(from).every((read) => read.cursor === null && !new URLSearchParams(read.query).has("workspace_id"))).toBe(true);
    expect(listReads(state).length).toBeGreaterThan(from);
    await assertDiscoveryOnly(state); await assertNoOverflow(page); await observation(page, "reload-filters");
  });

  test("a released older filter response cannot replace newer authorized results", async ({ page }) => {
    const state = await setup(page, "en", 390, discoveryPath);
    await expect(rowLinks(page)).toHaveCount(40); await settle(state);
    state.holdQuery = "evidence 110";
    const search = page.getByRole("textbox", { name: en.sessions.filters.search, exact: true });
    await search.fill("evidence 110");
    await expect.poll(() => state.heldDiscovery.length).toBe(1);
    const old = listReads(state).at(-1)!;
    expect(old.ids).toEqual([state.rows[110]!.id]); expect(old.completedAt).toBeUndefined();
    await search.fill("evidence 111");
    await expect(page.getByRole("link", { name: state.rows[111]!.title!, exact: true })).toBeVisible();
    state.releaseDiscovery();
    await expect.poll(() => old.completedAt !== undefined).toBe(true);
    await filteredReady(page, state, "evidence 111");
    expect(await rowIds(page)).toEqual([state.rows[111]!.id]);
    await expect(page.getByRole("link", { name: state.rows[110]!.title!, exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("q")).toBe("evidence 111");
    expect(listReads(state).filter((read) => new URLSearchParams(read.query).get("q") === "evidence 111").every((read) => read.cursor === null)).toBe(true);
    await assertDiscoveryOnly(state); await observation(page, "late-filter-released");
  });
});

for (const denial of [401, 403, 404]) {
  test(`known ${denial}, then outage, then fresh authorization never revives denied metadata`, async ({ page }) => {
    const state = await setup(page, "en", 1440, discoveryPath);
    await expect(rowLinks(page)).toHaveCount(40); await settle(state);
    const originalTitles = state.rows.slice(0, 40).map((row) => row.title!);
    state.listStatus = denial;
    await page.getByRole("button", { name: en.sessions.discovery.refresh, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(en.sessions.discovery.accessLost);
    await expect(rowLinks(page)).toHaveCount(0); await settle(state);
    expect(listReads(state).at(-1)!.status).toBe(denial);
    await observation(page, "known-access-loss");
    state.listStatus = 503;
    await page.getByRole("button", { name: en.sessions.loadError.retry, exact: true }).click();
    await expect.poll(() => listReads(state).at(-1)?.status).toBe(503);
    await expect(page.getByRole("alert")).toContainText(en.sessions.discovery.loadError);
    await expect(page.getByRole("button", { name: en.sessions.loadError.retry, exact: true })).toBeEnabled();
    await settle(state); await expect(rowLinks(page)).toHaveCount(0);
    for (const title of originalTitles) await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: originalNoteTitle, exact: true })).toHaveCount(0);
    await observation(page, "outage-does-not-revive");
    state.rows = [{ ...state.rows[110]!, title: "Freshly authorized recovery evidence" }];
    state.generation += 1; state.listStatus = 200;
    await page.getByRole("button", { name: en.sessions.loadError.retry, exact: true }).click();
    await expect(page.getByRole("link", { name: "Freshly authorized recovery evidence", exact: true })).toBeVisible();
    await expect(rowLinks(page)).toHaveCount(1); await settle(state);
    expect(listReads(state).at(-1)!.status).toBe(200); expect(listReads(state).at(-1)!.cursor).toBeNull();
    for (const title of originalTitles) await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);
    await assertDiscoveryOnly(state); await observation(page, "fresh-authorization-recovery");
  });
}

test("partial refresh keeps focused reading order until deliberate Show latest", async ({ page }) => {
  const state = await setup(page, "en", 1440, discoveryPath);
  await expect(rowLinks(page)).toHaveCount(40); await settle(state);
  const before = await rowIds(page), displaced = state.rows[39]!, promoted = state.rows[40]!;
  state.rows = [{ ...promoted, last_event_at: new Date(Date.parse(state.rows[0]!.last_event_at) + 60_000).toISOString() },
    ...state.rows.filter((row) => row.id !== promoted.id)]; state.generation += 1;
  state.holdNextList = true;
  await page.getByRole("button", { name: en.sessions.discovery.refresh, exact: true }).click();
  await expect.poll(() => state.heldDiscovery.length).toBe(1);
  const focused = page.locator(`#owner-session-link-${displaced.id}`);
  await focused.scrollIntoViewIfNeeded(); await focused.focus(); await expect(focused).toBeFocused();
  await observation(page, "partial-refresh-pending");
  const response = listReads(state).at(-1)!;
  expect(response.ids).not.toContain(displaced.id); expect(response.ids?.[0]).toBe(promoted.id);
  state.releaseDiscovery(); await settle(state);
  const latest = page.getByRole("button", { name: en.sessions.discovery.showLatest, exact: true });
  await expect(latest).toBeVisible(); expect(await rowIds(page)).toEqual(before); await expect(focused).toBeFocused();
  await expect(focused).toBeInViewport();
  await expect(page.getByText(en.sessions.discovery.retainedMetadata, { exact: true })).toBeVisible();
  await observation(page, "partial-refresh-keeps-reading-position");
  await latest.click();
  await expect.poll(() => rowIds(page)).toEqual(state.rows.slice(0, 40).map((row) => row.id));
  await expect(focused).toHaveCount(0);
  await assertDiscoveryOnly(state); await observation(page, "deliberate-show-latest");
});
