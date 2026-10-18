// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { alphaSlug, betaSlug, installObserverFixture, observerRoute, type ObserverFixture } from "./fixtures/observer-fixture";

test.skip(process.env.BACKPLANE_E2E_OBSERVER_FIXTURE !== "1", "Set BACKPLANE_E2E_OBSERVER_FIXTURE=1 for synthetic actual-shell Observer checks");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(45_000);
const assertUI = expect.configure({ timeout: 3000 });
const labelsByLocale = { en, es, "pt-BR": pt };
type Locale = keyof typeof labelsByLocale;
const inputHashes = () => Object.fromEntries([
  "e2e/observer-continuity.spec.ts", "e2e/fixtures/observer-fixture.ts", "src/App.tsx",
  "src/components/layout/TopBar.tsx", "src/providers/WebSocketProvider.tsx", "src/lib/websocket.ts",
  "src/features/observer/components/ObserverPanel.tsx", "src/features/observer/components/ObserverEventRow.tsx",
  "src/features/observer/hooks/useObserverEvents.ts", "src/i18n/locales/en.json", "src/i18n/locales/es.json", "src/i18n/locales/pt-BR.json",
].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const fixtures = new Map<Page, { state: ObserverFixture; inputsBefore: ReturnType<typeof inputHashes> }>();

test.afterEach(async ({ page }, info) => {
  const fixture = fixtures.get(page);
  if (!fixture) return;
  const ledger = info.outputPath("observer-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), url: page.url(),
    ui: await page.evaluate(() => ({
      activeTag: document.activeElement?.tagName,
      activeTestId: document.activeElement?.getAttribute("data-testid"),
      activeLabel: document.activeElement?.getAttribute("aria-label"),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      openDetails: document.querySelectorAll("details[open]").length,
    })),
    inputsBefore: fixture.inputsBefore, inputsAfter: inputHashes(),
    requests: fixture.state.requests, sockets: fixture.state.socketLedger,
    failures: fixture.state.failures, unexpected: fixture.state.unexpected,
  }, null, 2));
  await info.attach("observer-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("observer-final-shell.png") });
  expect(fixture.state.unexpected).toEqual([]);
  fixtures.delete(page);
});

async function setup(page: Page, locale: Locale = "en", width = 1440, initialSlug = alphaSlug) {
  await page.setViewportSize({ width, height: 900 });
  const state = await installObserverFixture(page, locale);
  fixtures.set(page, { state, inputsBefore: inputHashes() });
  await page.goto(observerRoute(initialSlug));
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("heading", { name: labelsByLocale[locale].boards.title, level: 1, exact: true })).toBeVisible();
  await expect.poll(() => state.subscriptions(initialSlug).includes("*")).toBe(true);
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
  return state;
}

async function openObserver(page: Page, locale: Locale = "en") {
  if (page.viewportSize()!.width < 768) {
    const summary = page.getByLabel(labelsByLocale[locale].a11y.topbar.moreControls, { exact: true });
    if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute("open")))) await summary.click();
  }
  const trigger = page.getByTestId("observer-trigger");
  await trigger.click();
  await expect(page.getByTestId("observer-expanded")).toBeVisible();
  return trigger;
}

async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
}

for (const [locale, width] of [["en", 1440], ["es", 390], ["pt-BR", 390]] as const) {
  test(`${locale} ${width}: All exposes retained namespaces and Escape returns focus without overflow`, async ({ page }) => {
    const state = await setup(page, locale, width);
    state.publish("activity.note.updated", "synthetic-note-event");
    state.publish("future_namespace.changed", "synthetic-unknown-event");
    const trigger = await openObserver(page, locale);
    const panel = page.getByTestId("observer-expanded");
    const list = page.getByTestId("observer-event-list");
    await expect(panel.getByRole("button", { name: labelsByLocale[locale].observer.namespaces.all, exact: true, pressed: true })).toBeVisible();
    await assertUI.soft(list).toContainText("synthetic-note-event");
    await assertUI.soft(list).toContainText("synthetic-unknown-event");
    await expectNoHorizontalOverflow(page);
    await panel.getByRole("heading", { name: labelsByLocale[locale].observer.title, exact: true }).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const tooltipBounds = await tooltip.boundingBox();
    expect(tooltipBounds).not.toBeNull();
    expect(tooltipBounds!.x).toBeGreaterThanOrEqual(8);
    expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(width - 8);
    await page.screenshot({ path: test.info().outputPath("all-namespaces.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    const returnTarget = await trigger.isVisible()
      ? trigger
      : page.getByLabel(labelsByLocale[locale].a11y.topbar.moreControls, { exact: true });
    await expect(returnTarget).toBeVisible();
    await assertUI.soft(returnTarget).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });
}

test("open arrivals are seen and pause preserves the displayed snapshot until captured arrivals resume", async ({ page }) => {
  const state = await setup(page);
  await openObserver(page);
  state.publish("card.moved", "seen-while-open");
  const list = page.getByTestId("observer-event-list");
  await expect(list).toContainText("seen-while-open");
  await assertUI.soft(page.getByTestId("observer-unread-badge")).toHaveCount(0);
  await page.getByLabel(en.observer.actions.pause, { exact: true }).click();
  state.publish("card.moved", "captured-while-paused");
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list).toContainText("seen-while-open");
  await expect(list).not.toContainText("captured-while-paused");
  await page.getByLabel(en.observer.actions.resume, { exact: true }).click();
  await assertUI.soft(list).toContainText("captured-while-paused");
  await expect(list).toContainText("seen-while-open");
  await assertUI.soft(page.getByTestId("observer-unread-badge")).toHaveCount(0);
});

test("denial and disconnect remain explicit beside rows and cached workspace return discards previous capture", async ({ page }) => {
  const state = await setup(page, "en", 1440, betaSlug);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  // A same-document history entry primes both permission caches while keeping
  // AppShell mounted. Browser Back then exercises the operator return path.
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, observerRoute());
  await expect.poll(() => state.subscriptions().includes("*")).toBe(true);
  await expect.poll(() => state.inflight).toBe(0);
  state.publish("card.moved", "alpha-only-capture");
  await openObserver(page);
  const panel = page.getByTestId("observer-expanded");
  await expect(page.getByTestId("observer-event-list")).toContainText("alpha-only-capture");
  // The tab can receive a typed refusal before its cached member role updates.
  // This checks control-frame presentation, not server revocation enforcement.
  state.denyWildcard();
  await assertUI.soft(panel).toContainText(/denied|refused|not authorized/i);
  await state.disconnect();
  await assertUI.soft(panel).toContainText(/disconnected/i);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${observerRoute(betaSlug)}$`));
  await expect.poll(() => state.subscriptions(betaSlug).includes("*")).toBe(true);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await openObserver(page);
  await assertUI.soft(page.getByTestId("observer-event-list")).not.toContainText("alpha-only-capture");
  expect(state.requests.filter((request) => request.path === `/api/workspaces/${betaSlug}/members`)).toHaveLength(1);
});

// Real browser delivery/rendering, with synthetic authorized frames. Logical
// buffer bounds are asserted here; heap samples are measurements, not a cap.
test("burst capture stays bounded through pause, filtering, resume and clear", async ({ page }) => {
  const state = await setup(page);
  await openObserver(page);
  const list = page.getByTestId("observer-event-list");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const samples: Record<string, unknown> = { initial: await cdp.send("Runtime.getHeapUsage") };
  const firstStart = Date.now();
  for (let index = 0; index < 1300; index += 1) state.publish("future_namespace.burst", `burst-${index}`);
  await expect(list.locator("li")).toHaveCount(1000);
  await expect(list).toContainText("burst-1299");
  samples.firstBurstMs = Date.now() - firstStart;
  await cdp.send("HeapProfiler.collectGarbage");
  samples.firstBuffer = await cdp.send("Runtime.getHeapUsage");
  await page.getByLabel(en.observer.actions.pause, { exact: true }).click();
  for (let index = 1300; index < 2600; index += 1) state.publish("future_namespace.burst", `burst-${index}`);
  await expect(page.getByRole("group", { name: en.observer.diagnostics.label })).toContainText("1600");
  await expect(list.locator("li")).toHaveCount(1000);
  await expect(list).toContainText("burst-1299");
  await expect(list).not.toContainText("burst-2599");
  await expect(page.getByTestId("observer-unread-badge")).toHaveText("99+");
  await cdp.send("HeapProfiler.collectGarbage");
  samples.pausedBuffers = await cdp.send("Runtime.getHeapUsage");
  await page.getByTestId("observer-search").fill("no-matching-frame");
  await expect(list).toContainText(en.observer.empty.filteredTitle);
  await page.getByTestId("observer-search").clear();
  await page.getByLabel(en.observer.actions.resume, { exact: true }).click();
  await expect(list.locator("li")).toHaveCount(1000);
  await expect(list).toContainText("burst-2599");
  await expect(list).not.toContainText("burst-1299");
  await expect(page.getByTestId("observer-unread-badge")).toHaveCount(0);
  await page.getByLabel(en.observer.actions.clear, { exact: true }).click();
  await expect(list).toContainText(en.observer.empty.title);
  await expect(page.getByTestId("observer-counts")).toContainText("0");
  await cdp.send("HeapProfiler.collectGarbage");
  samples.cleared = await cdp.send("Runtime.getHeapUsage");
  const heapReceipt = test.info().outputPath("observer-heap-samples.json");
  writeFileSync(heapReceipt, JSON.stringify(samples, null, 2));
  await test.info().attach("observer-heap-samples", { path: heapReceipt, contentType: "application/json" });
  await cdp.detach();
  expect(state.requests.filter((request) => request.path.includes("/contents") || request.path.includes("/resources"))).toEqual([]);
});

test.describe("narrow touch controls", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("opens a diagnostic payload and clears it with touch and reduced motion", async ({ page }) => {
    const state = await setup(page, "en", 390);
    state.publish("future_namespace.changed", "touch-payload", alphaSlug, { summary: "Cookie: session=SYNTHETIC_COOKIE", execution_id: "safe-touch-id", details: "x".repeat(20000) });
    await page.getByLabel(en.a11y.topbar.moreControls, { exact: true }).tap();
    await page.getByTestId("observer-trigger").tap();
    const list = page.getByTestId("observer-event-list");
    await expect(list).toContainText("touch-payload");
    await list.getByRole("button").tap();
    await expect(list).toContainText("safe-touch-id");
    await expect(list).toContainText("[redacted]");
    await expect(list).not.toContainText("SYNTHETIC_COOKIE");
    await expectNoHorizontalOverflow(page);
    await page.getByLabel(en.observer.actions.clear, { exact: true }).tap();
    await expect(list).toContainText(en.observer.empty.title);
    await expectNoHorizontalOverflow(page);
  });
});
