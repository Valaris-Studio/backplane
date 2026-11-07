// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { sha } from "./fixtures/session-window-fixture";
import {
  bodyFor, collectionPath, ids, installResourceFixture, reportName, resourceApi, unexpectedConsole,
  type ResourceFixture, type ResourceScope,
} from "./fixtures/a06-resource-destination";

test.skip(process.env.BACKPLANE_E2E_A06_RESOURCE_FIXTURE !== "1", "Set BACKPLANE_E2E_A06_RESOURCE_FIXTURE=1 for synthetic actual-shell resource journeys");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });

const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const inputs = ["e2e/a06-resource-destination.spec.ts", "e2e/fixtures/a06-resource-destination.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts",
  "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json"];
const sourceInputs = ["src/features/resources/components/ResourceList.tsx", "src/features/resources/components/ResourceGrid.tsx",
  "src/features/resources/api/use-resources.ts", "src/features/resources/hooks/use-resource-destination.ts", "src/types/resource.ts"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A06_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head?: string; tree?: string; source_manifest?: string; files: Record<string, string> } : null;
type Run = {
  fixture: ResourceFixture; locale: Locale; width: number; before: ReturnType<typeof hashes>;
  observations: unknown[]; popups: { page: Page; fixture: ResourceFixture }[];
};
const runs = new Map<Page, Run>();
const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const entry = (page: Page) => page.evaluate(() => ({ key: history.state?.key, idx: history.state?.idx }));
const item = (page: Page, id: string) => page.locator(`a#resource-item-${id}`);
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();
const sheet = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const byteRequests = (fixture: ResourceFixture) => fixture.resourceRequests.filter((request) => request.kind === "body");
const signRequests = (fixture: ResourceFixture) => fixture.resourceRequests.filter((request) => request.kind === "sign");

async function settled(fixture: ResourceFixture) {
  await expect.poll(() => fixture.inflight).toBe(0);
  expect(fixture.unexpected).toEqual([]);
}

async function setup(page: Page, locale: Locale, width: number) {
  expect(manifest, "Bind observed JS/CSS responses to root's exact preserved dist manifest").not.toBeNull();
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const fixture = await installResourceFixture(page, locale);
  runs.set(page, { fixture, locale, width, before: hashes(inputs), observations: [], popups: [] });
  return fixture;
}

async function shellReady(page: Page, fixture: ResourceFixture) {
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => fixture.subscriptions.includes("activity.resource.*")).toBe(true);
}

async function observe(page: Page, name: string, anchorId?: string) {
  const run = runs.get(page)!;
  const position = await page.evaluate((id) => {
    const anchor = id ? document.getElementById(`resource-item-${id}`) : null;
    const ancestors = [];
    for (let node = anchor?.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1) ancestors.push({ tag: node.tagName, className: node.className,
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
    }
    return {
      windowScroll: window.scrollY, anchorTop: anchor?.getBoundingClientRect().top ?? null,
      activeId: document.activeElement?.id, focusTag: document.activeElement?.tagName,
      touchPoints: navigator.maxTouchPoints, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      scrollContainers: ancestors,
    };
  }, anchorId);
  const observation = { name, url: page.url(), entry: await entry(page), ...position,
    signingRequests: signRequests(run.fixture).length, bodyRequests: byteRequests(run.fixture).length };
  run.observations.push(observation);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  expect(position.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(position.reducedMotion).toBe(true);
  if (run.width === 390) expect(position.touchPoints).toBeGreaterThan(0);
  return observation;
}

async function preview(page: Page, fixture: ResourceFixture, id: string, title: string) {
  await expect(sheet(page, title)).toBeVisible();
  await expect(sheet(page, title).locator("pre")).toHaveText(bodyFor(id));
  await settled(fixture);
  expect(signRequests(fixture).some((request) => request.resourceId === id && request.status === 200)).toBe(true);
  expect(byteRequests(fixture).some((request) => request.resourceId === id && request.status === 200 && request.bodySha256 === sha(bodyFor(id)))).toBe(true);
}

async function close(page: Page, title: string, locale: Locale, width: number) {
  await activate(sheet(page, title).getByRole("button", { name: catalogs[locale].common.close, exact: true }), width);
  await expect(sheet(page, title)).toBeHidden();
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page);
  if (!run) return;
  const fixtures = [run.fixture, ...run.popups.map((popup) => popup.fixture)];
  fixtures.forEach((fixture) => { fixture.releaseResources(); fixture.release(); });
  await Promise.all(fixtures.flatMap((fixture) => fixture.pendingAssets));
  const after = hashes(inputs);
  const assets = fixtures.flatMap((fixture, pageIndex) => fixture.assets.map((asset) => ({
    ...asset, pageIndex, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null,
  })));
  const receipt = info.outputPath("resource-destination-ledger.json");
  writeFileSync(receipt, JSON.stringify({
    scope: "Actual preserved Vite AppShell/ResourceList/preview; synthetic HTTP and WebSocket, not deployed authorization or backend persistence proof",
    baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    sourceBase: manifest?.head, sourceTree: manifest?.tree, sourceManifest: manifest?.source_manifest,
    fixtureInputsBefore: run.before, fixtureInputsAfter: after, currentSourceContextOnly: hashes(sourceInputs),
    locale: run.locale, viewport: page.viewportSize(), browser: page.context().browser()?.version(),
    builtAssets: assets, observations: run.observations, status: info.status,
    pages: fixtures.map((fixture, index) => ({ index, requests: fixture.requests, resourceRequests: fixture.resourceRequests,
      sockets: fixture.socketLedger, downloads: fixture.downloads, failures: fixture.failures,
      unexpected: fixture.unexpected, console: fixture.consoleReceipts, unexpectedConsole: unexpectedConsole(fixture) })),
  }, null, 2));
  await info.attach("resource-destination-ledger", { path: receipt, contentType: "application/json" });
  if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") });
  for (const fixture of fixtures) {
    expect.soft(fixture.unexpected).toEqual([]);
    expect.soft(unexpectedConsole(fixture)).toEqual([]);
    // Aborts are expected only at resource reads explicitly exercised by these
    // journeys (route cancellation or native attachment download).
    expect.soft(fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED")
      || !(failure.startsWith(resourceApi("board")) || failure.startsWith(resourceApi("workspace"))
        || failure.startsWith("/__a06_synthetic_body/")))).toEqual([]);
  }
  expect.soft(after).toEqual(run.before);
  expect.soft(assets.length).toBeGreaterThan(0);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.expected !== asset.sha256)).toEqual([]);
  runs.delete(page);
});

for (const locale of Object.keys(catalogs) as Locale[]) {
  for (const width of [1440, 390]) {
    const scope: ResourceScope = width === 1440 ? "board" : "workspace";
    test.describe(`${locale} ${width} ${scope} resources`, () => {
      test.use({ hasTouch: width === 390 });
      test("folder filters, deliberate preview, close/Back focus and grid/reload preserve context", async ({ page }) => {
        const fixture = await setup(page, locale, width), t = catalogs[locale], key = ids(scope);
        await page.goto(collectionPath(scope));
        await shellReady(page, fixture);
        await expect(item(page, key.design)).toBeVisible();
        await activate(item(page, key.design), width);
        await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe(key.design);
        await activate(item(page, key.final), width);
        await expect(page.getByRole("navigation", { name: t.resources.folderPath }).getByRole("button", { name: "Final", exact: true })).toBeVisible();
        await expect(item(page, key.report(52))).toBeAttached();
        await settled(fixture);
        expect(signRequests(fixture)).toEqual([]);
        expect(byteRequests(fixture)).toEqual([]);
        expect(fixture.resourceRequests.some((request) => request.kind === "collection" && request.returned === 64)).toBe(true);

        await activate(page.getByRole("button", { name: `${t.resources.filterType}: ${t.resources.allTypes}`, exact: true }), width);
        await activate(page.getByRole("menuitem", { name: t.resources.filesOnly, exact: true }), width);
        await activate(page.getByRole("button", { name: t.resources.tags, exact: true }), width);
        await activate(page.getByRole("menuitem", { name: "review", exact: true }), width);
        await page.getByPlaceholder(t.resources.searchPlaceholder, { exact: true }).fill("Report");
        await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Report");
        await expect.poll(() => new URL(page.url()).searchParams.get("resource_type")).toBe("file");
        await expect.poll(() => new URL(page.url()).searchParams.get("tag")).toBe("review");
        await settled(fixture);
        const originURL = path(page), originEntry = await entry(page);
        const target = item(page, key.report(52));
        await expect(target).toHaveAttribute("href", `${collectionPath(scope)}?resource=${key.report(52)}`);
        await target.scrollIntoViewIfNeeded();
        await target.focus();
        const before = await observe(page, "filtered-origin", key.report(52));
        expect(before.scrollContainers.some((container) => container.scrollTop > 0) || before.windowScroll > 0).toBe(true);
        if (width === 1440) await target.press("Enter"); else await target.tap();
        await preview(page, fixture, key.report(52), reportName(52));
        await observe(page, "deliberate-preview");
        await close(page, reportName(52), locale, width);
        await expect.poll(() => path(page)).toBe(originURL);
        await expect.poll(() => entry(page)).toEqual(originEntry);
        await expect(target).toBeFocused();
        await expect.poll(async () => Math.abs((await target.boundingBox())!.y - before.anchorTop!)).toBeLessThanOrEqual(3);
        await observe(page, "close-restored", key.report(52));

        await activate(target, width);
        await preview(page, fixture, key.report(52), reportName(52));
        await page.goBack();
        await expect.poll(() => path(page)).toBe(originURL);
        await expect.poll(() => entry(page)).toEqual(originEntry);
        await expect(target).toBeFocused();
        await expect(page.getByPlaceholder(t.resources.searchPlaceholder, { exact: true })).toHaveValue("Report");
        await activate(page.getByRole("button", { name: t.resources.grid, exact: true }), width);
        await expect(target).toHaveAttribute("href", `${collectionPath(scope)}?resource=${key.report(52)}`);
        await observe(page, "grid-native-links", key.report(52));
        const beforeReloadBodies = byteRequests(fixture).length, beforeReloadSigns = signRequests(fixture).length;
        await page.reload();
        await expect(item(page, key.report(52))).toBeAttached();
        await settled(fixture);
        expect(path(page)).toBe(originURL);
        await expect(page.getByPlaceholder(t.resources.searchPlaceholder, { exact: true })).toHaveValue("Report");
        expect(await page.evaluate(() => localStorage.getItem("resource-view-mode"))).toBe("grid");
        expect(byteRequests(fixture)).toHaveLength(beforeReloadBodies);
        expect(signRequests(fixture)).toHaveLength(beforeReloadSigns);
        await observe(page, "reload-filtered-grid");
      });
    });
  }
}

test("cold exact target resolves outside the returned folder/filter, then reload and cold close retain current scope", async ({ page }) => {
  const fixture = await setup(page, "en", 1440), key = ids("board");
  fixture.heldDetails.add(key.hidden);
  const params = new URLSearchParams({ folder: key.final, q: "Report", resource_type: "file", tag: "review", resource: key.hidden });
  await page.goto(`${collectionPath("board")}?${params}`);
  await shellReady(page, fixture);
  await expect(item(page, key.report(0))).toBeVisible();
  await expect.poll(() => fixture.pendingDetails.get(key.hidden)?.length ?? 0).toBe(1);
  await expect(page.getByRole("main").getByRole("status", { name: "" }).filter({ hasText: en.common.loading })).toBeVisible();
  expect(signRequests(fixture)).toEqual([]);
  expect(byteRequests(fixture)).toEqual([]);
  await observe(page, "exact-target-loading");
  fixture.releaseDetail(key.hidden);
  await preview(page, fixture, key.hidden, "Hidden evidence.txt");
  await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe(key.other);
  expect(fixture.resourceRequests.filter((request) => request.kind === "collection").every((request) => !request.ids?.includes(key.hidden))).toBe(true);
  const resolvedURL = path(page);
  await observe(page, "off-filter-exact-preview");
  await page.reload();
  await preview(page, fixture, key.hidden, "Hidden evidence.txt");
  expect(path(page)).toBe(resolvedURL);
  const coldIndex = (await entry(page)).idx;
  await close(page, "Hidden evidence.txt", "en", 1440);
  await expect.poll(() => new URL(page.url()).searchParams.has("resource")).toBe(false);
  expect((await entry(page)).idx).toBe(coldIndex);
  expect(new URL(page.url()).searchParams.get("folder")).toBe(key.other);
  expect(new URL(page.url()).searchParams.get("q")).toBe("Report");
  await observe(page, "cold-close-keeps-filtered-folder");
});

test("folder destinations never sign and a workspace alias canonicalizes without cold-close popping to the prior page", async ({ page }) => {
  const fixture = await setup(page, "en", 1440), workspace = ids("workspace"), board = ids("board");
  await page.goto(`${collectionPath("workspace")}?resource=${workspace.final}`);
  await expect.poll(() => path(page)).toBe(`${collectionPath("workspace")}?folder=${workspace.final}`);
  await expect(page.getByRole("navigation", { name: en.resources.folderPath }).getByRole("button", { name: "Design", exact: true })).toBeVisible();
  await expect(item(page, workspace.report(0))).toBeVisible();
  await settled(fixture);
  expect(signRequests(fixture)).toEqual([]);
  expect(byteRequests(fixture)).toEqual([]);
  expect(await page.getByRole("dialog").count()).toBe(0);
  await observe(page, "folder-only-destination");
  // A real document navigation creates a cold entry with an earlier, different
  // product page. This does not claim unimplemented A04/A05 origin wiring.
  await page.goto(`${collectionPath("workspace")}?resource=${board.hidden}`);
  await preview(page, fixture, board.hidden, "Hidden evidence.txt");
  await expect.poll(() => new URL(page.url()).pathname).toBe(collectionPath("board"));
  expect(fixture.resourceRequests.some((request) => request.kind === "detail" && request.path === `${resourceApi("workspace")}/${board.hidden}`)).toBe(true);
  expect(fixture.resourceRequests.some((request) => request.kind === "detail" && request.path === `${resourceApi("board")}/${board.hidden}`)).toBe(true);
  const coldIndex = (await entry(page)).idx;
  await close(page, "Hidden evidence.txt", "en", 1440);
  await expect.poll(() => path(page)).toBe(`${collectionPath("board")}?folder=${board.other}`);
  expect((await entry(page)).idx).toBe(coldIndex);
  await observe(page, "alias-close-stays-on-destination");
});

test("live resource metadata moves and renames the exact preview; deletion removes body and download", async ({ page }) => {
  const fixture = await setup(page, "en", 1440), key = ids("board");
  await page.goto(`${collectionPath("board")}?resource=${key.hidden}`);
  await shellReady(page, fixture);
  await preview(page, fixture, key.hidden, "Hidden evidence.txt");
  const bodiesBefore = byteRequests(fixture).length, signsBefore = signRequests(fixture).length;
  fixture.resources.set(key.hidden, { ...fixture.resources.get(key.hidden)!, name: "Renamed evidence.txt", parent_id: key.moved });
  fixture.emitResource(key.hidden);
  await expect(sheet(page, "Renamed evidence.txt")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe(key.moved);
  await settled(fixture);
  expect(byteRequests(fixture)).toHaveLength(bodiesBefore);
  expect(signRequests(fixture)).toHaveLength(signsBefore);
  await expect(sheet(page, "Renamed evidence.txt").locator("pre")).toHaveText(bodyFor(key.hidden));
  await observe(page, "moved-renamed-current-target");
  fixture.detailStatus.set(key.hidden, 404);
  fixture.emitResource(key.hidden);
  await expect(sheet(page, en.resources.unavailableTitle).getByRole("alert")).toContainText(en.resources.resourceUnavailable);
  await expect(page.locator("pre").filter({ hasText: bodyFor(key.hidden) })).toHaveCount(0);
  await expect(sheet(page, en.resources.unavailableTitle).getByRole("button", { name: en.common.download, exact: true })).toHaveCount(0);
  await settled(fixture);
  expect(new URL(page.url()).searchParams.get("resource")).toBe(key.hidden);
  await observe(page, "deleted-current-target");
});

test("a late old target cannot replace the newly chosen denied identity", async ({ page }) => {
  const fixture = await setup(page, "en", 1440), key = ids("board");
  fixture.heldDetails.add(key.hidden);
  fixture.detailStatus.set(key.alternate, 403);
  await page.goto(`${collectionPath("board")}?resource=${key.hidden}`);
  await shellReady(page, fixture);
  await expect(item(page, key.alternate)).toBeVisible();
  await expect.poll(() => fixture.pendingDetails.get(key.hidden)?.length ?? 0).toBe(1);
  await item(page, key.alternate).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("resource")).toBe(key.alternate);
  await expect(sheet(page, en.resources.unavailableTitle).getByRole("alert")).toContainText(en.resources.resourceUnavailable);
  fixture.releaseDetail(key.hidden);
  await settled(fixture);
  expect(new URL(page.url()).searchParams.get("resource")).toBe(key.alternate);
  await expect(sheet(page, "Hidden evidence.txt")).toHaveCount(0);
  await expect(page.locator("pre")).toHaveCount(0);
  expect(signRequests(fixture).filter((request) => request.resourceId === key.hidden)).toEqual([]);
  expect(byteRequests(fixture)).toEqual([]);
  await observe(page, "late-target-after-denial");
});

test("unsupported files stay download-only and the existing native download receives exact bytes", async ({ page }) => {
  const fixture = await setup(page, "en", 1440), key = ids("workspace");
  await page.goto(collectionPath("workspace"));
  await expect(item(page, key.restricted)).toBeVisible();
  await settled(fixture);
  expect(signRequests(fixture)).toEqual([]);
  await item(page, key.restricted).click();
  const dialog = sheet(page, "Unsupported archive.bin");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(en.resources.noPreviewDescription, { exact: true })).toBeVisible();
  await settled(fixture);
  expect(signRequests(fixture)).toHaveLength(1);
  expect(byteRequests(fixture)).toEqual([]);
  await observe(page, "unsupported-before-download");
  await dialog.getByRole("button", { name: en.common.download, exact: true }).last().click();
  await expect.poll(() => fixture.downloads.length).toBe(1);
  await expect.poll(() => byteRequests(fixture).filter((request) => request.navigation && request.status === 200).length).toBe(1);
  await settled(fixture);
  expect(signRequests(fixture)).toHaveLength(2);
  expect(fixture.downloads[0]?.filename).toBe("Unsupported archive.bin");
  expect(byteRequests(fixture)[0]?.bodySha256).toBe(sha(bodyFor(key.restricted)));
  await expect(dialog).toBeVisible();
  await observe(page, "native-download-complete");
});

test("native modifier-click on a grid anchor opens an isolated exact resource without private filters", async ({ page, context }) => {
  const fixture = await setup(page, "en", 1440), key = ids("board");
  const origin = `${collectionPath("board")}?folder=${key.final}&q=Report&resource_type=file&tag=review`;
  await page.goto(origin);
  await expect(item(page, key.report(0))).toBeVisible();
  await page.getByRole("button", { name: en.resources.grid, exact: true }).click();
  const target = item(page, key.report(0));
  await expect(target).toHaveAttribute("href", `${collectionPath("board")}?resource=${key.report(0)}`);
  // The first child socket can start before page-specific routes finish
  // installing. Intercept it at context scope before the native click and
  // attach its queued subscription frames to that child's synthetic ledger.
  let resolveChild!: (fixture: ResourceFixture) => void;
  const childReady = new Promise<ResourceFixture>((resolve) => { resolveChild = resolve; });
  await context.routeWebSocket("**/ws/workspaces/**", (socket) => {
    const url = new URL(socket.url());
    if (url.origin !== new URL(page.url()).origin.replace(/^http/, "ws")
      || url.pathname !== `/ws/workspaces/${new URL(page.url()).pathname.split("/")[1]}/events`) {
      fixture.unexpected.push(`Unexpected child socket: ${socket.url()}`);
      void socket.close({ code: 1008, reason: "Outside synthetic resource fixture" });
      return;
    }
    const messages: unknown[] = [];
    let receive = (message: unknown) => { messages.push(message); };
    socket.onMessage((message) => receive(message));
    void childReady.then((child) => {
      child.socket = socket;
      child.socketsOpened += 1;
      child.subscriptions = [];
      const connection = child.socketsOpened;
      child.socketLedger.push({ kind: "connected", at: Date.now(), connection });
      receive = (message) => {
        const frame = JSON.parse(String(message));
        if (Array.isArray(frame.subscribe)) {
          child.subscriptions = frame.subscribe;
          child.socketLedger.push({ kind: "subscribe", at: Date.now(), connection, payload: frame.subscribe });
        }
      };
      messages.forEach(receive);
    });
  });
  const preparations = new Map<Page, Promise<ResourceFixture>>();
  const preparePopup = (popup: Page) => {
    let ready = preparations.get(popup);
    if (!ready) {
      ready = installResourceFixture(popup, "en").then((childFixture) => {
        runs.get(page)!.popups.push({ page: popup, fixture: childFixture });
        resolveChild(childFixture);
        return childFixture;
      });
      preparations.set(popup, ready);
    }
    return ready;
  };
  // Chromium may issue the first document before it exposes a Frame. Admit
  // only the exact static document, then hold its first script until all of
  // the popup's strict HTTP/WebSocket fixtures are installed.
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    let popup: Page;
    try { popup = request.frame().page(); }
    catch {
      if (request.method() === "GET" && request.isNavigationRequest()
        && url.origin === new URL(page.url()).origin && url.pathname === collectionPath("board")
        && url.search === `?resource=${key.report(0)}`) {
        runs.get(page)!.observations.push({ name: "native-popup-first-document", url: url.href, method: request.method(), frameAvailable: false });
        return route.fallback();
      }
      fixture.unexpected.push(`Unbound popup request refused: ${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (popup === page) return route.fallback();
    if (url.origin !== new URL(page.url()).origin) {
      fixture.unexpected.push(`External popup request refused: ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (request.isNavigationRequest() && url.pathname === collectionPath("board")
      && url.search === `?resource=${key.report(0)}`) {
      runs.get(page)!.observations.push({ name: "native-popup-first-document", url: url.href, method: request.method(), frameAvailable: true });
      await preparePopup(popup);
      return route.fallback();
    }
    if (url.pathname.startsWith("/assets/") && manifest?.files[url.pathname.slice(1)]) {
      await preparePopup(popup);
      return route.fallback();
    }
    fixture.unexpected.push(`Popup request escaped its strict page fixture: ${request.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  // A native modifier-click opens a tab without an opener; Chromium reports
  // the context page event, rather than an opener-owned popup event.
  const [popup] = await Promise.all([context.waitForEvent("page"), target.click({ modifiers: ["ControlOrMeta"] })]);
  const popupFixture = await preparePopup(popup);
  await popup.waitForLoadState("domcontentloaded");
  await preview(popup, popupFixture, key.report(0), reportName(0));
  const popupURL = new URL(popup.url());
  expect(popupURL.pathname).toBe(collectionPath("board"));
  expect(popupURL.searchParams.get("resource")).toBe(key.report(0));
  expect(popupURL.searchParams.get("folder")).toBe(key.final);
  for (const name of ["q", "resource_type", "tag", "return", "origin"]) expect(popupURL.searchParams.has(name)).toBe(false);
  expect(await popup.evaluate(() => history.state?.usr?.bpReturn ?? null)).toBeNull();
  expect(path(page)).toBe(origin);
  expect(signRequests(fixture)).toEqual([]);
  expect(byteRequests(fixture)).toEqual([]);
  runs.get(page)!.observations.push({ name: "native-grid-popup", parentURL: page.url(), popupURL: popup.url(), popupHistory: await entry(popup) });
  await popup.screenshot({ path: test.info().outputPath("native-grid-popup.png") });
  await popup.close();
  await observe(page, "native-popup-parent-unchanged");
});

for (const mode of ["list", "grid"] as const) {
  test(`releasing an active ${mode} drag on its origin does not follow the resource anchor`, async ({ page }) => {
    const fixture = await setup(page, "en", 1440), key = ids("board");
    const origin = `${collectionPath("board")}?folder=${key.final}&q=Report&tag=review`;
    await page.goto(origin);
    await shellReady(page, fixture);
    if (mode === "grid") await page.getByRole("button", { name: en.resources.grid, exact: true }).click();
    const target = item(page, key.report(0));
    await expect(target).toBeVisible();
    await settled(fixture);
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
    });
    const bounds = (await target.boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 24, y, { steps: 4 });
    await expect(page.locator(".opacity-40").filter({ has: target })).toHaveCount(1);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    runs.get(page)!.observations.push({ name: "post-drag-default-action", mode, documents, url: page.url() });
    expect(documents).toEqual([]);
    expect(path(page)).toBe(origin);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(signRequests(fixture)).toEqual([]);
    expect(byteRequests(fixture)).toEqual([]);
    await observe(page, `post-drag-${mode}`, key.report(0));
  });
}
