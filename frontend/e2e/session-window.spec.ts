// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page, type Locator } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import {
  boardId, bodyText, byteRequests, cardId, contentId, contentRequests, contentsPath, exactCallId,
  installWindowFixture, records, routePath, session, sessionPath, slug, windowRequests, type WindowFixture,
} from "./fixtures/session-window-fixture";

// Run against loopback Vite or a frozen production preview. No real API,
// credentials, captured bodies, or mutation reaches an application server.
test.skip(process.env.BACKPLANE_E2E_SESSION_WINDOW_FIXTURE !== "1", "Set BACKPLANE_E2E_SESSION_WINDOW_FIXTURE=1 for synthetic AppShell acceptance");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(45_000);
const states = new Map<Page, WindowFixture>();
const s = en.sessions;

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.release();
  await info.attach("synthetic-request-ledger", {
    body: JSON.stringify({ dataset: records.length, requests: state.requests, failures: state.failures, unexpected: state.unexpected }, null, 2),
    contentType: "application/json",
  });
  if (info.status === info.expectedStatus) expect(state.unexpected).toEqual([]);
  states.delete(page);
});

async function setup(page: Page, locale = "en", hash = "") {
  const state = await installWindowFixture(page, locale);
  states.set(page, state);
  await page.goto(`${routePath}${hash}`);
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  return state;
}

async function settle(state: WindowFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function transcript(page: Page) {
  const tab = page.getByRole("tab", { name: s.contents.title, exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  const reader = page.getByRole("region", { name: s.contents.title, exact: true });
  await expect(reader).toBeVisible();
  return reader;
}

async function geometry(page: Page, controls: Locator[], width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const measurements = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (width === 375) {
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    measurements.push({ text: await control.textContent(), ...box });
  }
  await test.info().attach("control-geometry", { body: JSON.stringify({ width, measurements }), contentType: "application/json" });
}

// Three orthogonal locale/viewport cases, rather than repeating every deep
// journey through a nine-cell matrix. All three registered locales and widths
// are measured with the real topbar, sidebar, sticky reader and tab controls.
for (const [locale, labels, width] of [["en", en, 1440], ["es", es, 375], ["pt-BR", pt, 1024]] as const) {
  test(`${locale} ${width}: peer readers reach recent evidence in one window`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await setup(page, locale);
    await page.screenshot({ path: test.info().outputPath("initial-shell.png") });
    const timeline = page.getByRole("tab", { name: labels.sessions.detail.tabs.timeline, exact: true });
    const readerTab = page.getByRole("tab", { name: labels.sessions.contents.title, exact: true });
    await expect(timeline).toBeVisible();
    await expect(readerTab).toBeVisible();
    await settle(state);
    expect(contentRequests(state)).toEqual([]);
    await timeline.focus();
    await page.keyboard.press("ArrowRight");
    await expect(readerTab).toBeFocused();
    await expect(readerTab).toHaveAttribute("aria-selected", "true");
    const reader = page.getByRole("region", { name: labels.sessions.contents.title, exact: true });
    await expect(reader.getByText("SYNTHETIC PREVIEW 10001", { exact: true })).toBeVisible();
    await settle(state);
    expect(windowRequests(state)).toHaveLength(1);
    expect(windowRequests(state)[0]).toMatchObject({ mode: "latest", returned: 100 });
    expect(contentRequests(state)).toHaveLength(1);
    expect(byteRequests(state)).toEqual([]);
    expect(await reader.locator("[id^='content-']").count()).toBeLessThanOrEqual(100);
    await expect(page.getByRole("region", { name: labels.sessions.timeline.title, exact: true })).not.toBeVisible();
    await geometry(page, [timeline, readerTab, reader.getByRole("combobox", { name: labels.sessions.contents.navigation.label })], width);
    await readerTab.focus();
    await page.screenshot({ path: test.info().outputPath("recent-reader-focus.png") });
    await page.keyboard.press("Home");
    await expect(timeline).toBeFocused();
    await expect(timeline).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    const tabs = page.getByRole("tablist", { name: labels.sessions.detail.tabs.label }).getByRole("tab");
    await expect(tabs.last()).toBeFocused();
    await readerTab.click();
    await expect(reader.getByText("SYNTHETIC PREVIEW 10001", { exact: true })).toBeVisible();
    expect(byteRequests(state)).toEqual([]);
  });
}

test("beginning, latest and exact anchor replace one bounded window and keep existing evidence inspectable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, "en", `#content-${contentId(5001)}`);
  const reader = page.getByRole("region", { name: s.contents.title, exact: true });
  const anchor = reader.locator(`#content-${contentId(5001)}`);
  await expect(page.getByRole("tab", { name: s.contents.title, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(anchor).toBeFocused();
  await expect(anchor).toBeInViewport();
  await settle(state);
  expect(windowRequests(state)).toHaveLength(1);
  expect(windowRequests(state)[0]).toMatchObject({ mode: "anchor", returned: 100 });
  expect(windowRequests(state)[0].query).toContain(`anchor_id=${contentId(5001)}`);
  expect(byteRequests(state)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("deep-link-evidence.png") });

  for (const [button, mode, first, last] of [["Beginning", "beginning", 1, 100], ["Later records", "later", 101, 200], ["Earlier records", "earlier", 1, 100], ["Latest", "latest", 9902, 10001]] as const) {
    const start = state.requests.length;
    await reader.getByRole("button", { name: button, exact: true }).click();
    await expect(reader.locator(`#content-${contentId(last)}`)).toBeVisible();
    await settle(state);
    expect(windowRequests(state, start)).toHaveLength(1);
    expect(windowRequests(state, start)[0]).toMatchObject({ mode, returned: 100 });
    expect(contentRequests(state, start)).toHaveLength(1);
    expect(byteRequests(state, start)).toEqual([]);
    await expect(reader.locator(`#content-${contentId(first)}`)).toBeAttached();
    await expect(anchor).toHaveCount(0);
    const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inReader: !!document.activeElement?.closest("section")?.querySelector("h2") }));
    expect(focused).toMatchObject({ tag: "H2", inReader: true });
    expect(new URL(page.url()).hash).not.toBe(`#content-${contentId(5001)}`);
  }
  const start = state.requests.length;
  await page.getByRole("tab", { name: s.detail.tabs.timeline, exact: true }).click();
  const row = page.locator("[data-call-row]").filter({ has: page.locator("[data-call-name]").filter({ hasText: /^backplane · update_card$/ }) });
  await row.getByRole("button", { name: /^backplane · update_card/ }).click();
  await row.getByRole("button", { name: s.contents.call.inspect, exact: true }).click();
  const inspector = row.getByRole("region", { name: s.contents.call.title, exact: true });
  await expect(inspector.getByText("SYNTHETIC PREVIEW 41", { exact: true })).toBeVisible();
  await settle(state);
  expect(contentRequests(state, start)).toHaveLength(1);
  expect(contentRequests(state, start)[0]).toMatchObject({ path: contentsPath, callId: exactCallId });
  await page.getByRole("button", { name: "Inspect Changed evidence for Review this bounded evidence", exact: true }).click();
  await expect(page.getByText(s.evidence.exact, { exact: true })).toBeVisible();
  await expect(page.getByText(s.evidence.correlated, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: s.evidence.return, exact: true }).click();
  await page.getByRole("button", { name: "Inspect Consulted evidence for Review this bounded evidence", exact: true }).click();
  await expect(page.getByText(s.evidence.correlated, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: s.evidence.read, exact: true }).click();
  await expect(page.getByRole("tab", { name: s.contents.title, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(reader.getByRole("heading", { name: s.contents.title, exact: true })).toBeFocused();
  expect(byteRequests(state)).toEqual([]);
});

test("off-window selection builds the same frozen handoff after unknown save and source loss", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  const state = await setup(page);
  const reader = await transcript(page);
  const recent = reader.locator(`#content-${contentId(10001)}`);
  await recent.locator("label").click();
  await expect(recent.getByRole("checkbox")).toBeChecked();
  await reader.getByRole("button", { name: "Beginning", exact: true }).click();
  const beginning = reader.locator(`#content-${contentId(1)}`);
  await beginning.locator("label").click();
  await expect(beginning.getByRole("checkbox")).toBeChecked();
  await expect(reader.locator(`#content-${contentId(10001)}`)).toHaveCount(0);
  expect(byteRequests(state)).toEqual([]);
  const previewStart = state.requests.length;
  await reader.getByRole("button", { name: s.contents.excerpt.preview, exact: true }).click();
  const preview = page.getByRole("dialog", { name: s.contents.excerpt.title, exact: true });
  const previewText = preview.getByRole("textbox", { name: s.contents.excerpt.previewLabel, exact: true });
  await expect(previewText).toHaveValue(new RegExp(bodyText(10001)));
  const value = await previewText.inputValue();
  expect(value.indexOf(bodyText(1))).toBeLessThan(value.indexOf(bodyText(10001)));
  const metadata = contentRequests(state, previewStart).filter((request) => request.path.endsWith("/metadata"));
  expect(metadata).toHaveLength(1);
  expect(metadata[0].ids?.toSorted()).toEqual([contentId(1), contentId(10001)].toSorted());
  expect(byteRequests(state, previewStart)).toHaveLength(2);
  expect(state.requests.indexOf(metadata[0])).toBeLessThan(state.requests.indexOf(byteRequests(state, previewStart)[0]));
  await preview.getByRole("button", { name: s.contents.excerpt.note.share, exact: true }).click();
  const draft = page.getByRole("dialog", { name: s.contents.excerpt.note.share, exact: true });
  await draft.getByRole("textbox", { name: s.contents.excerpt.note.title, exact: true }).fill("Synthetic reviewed reader handoff");
  await draft.getByRole("combobox", { name: /^Workspace/ }).selectOption(slug);
  await draft.getByRole("combobox", { name: /^Board/ }).selectOption(boardId);
  await draft.getByRole("combobox", { name: /^Card/ }).selectOption(cardId);
  const editor = draft.getByRole("region", { name: s.contents.excerpt.note.content, exact: true }).locator("[contenteditable]");
  const reviewedBody = await editor.innerText();
  await draft.getByRole("button", { name: s.contents.excerpt.note.save, exact: true }).click();
  await expect(draft.getByRole("alert")).toContainText("may have been saved");
  const writes = () => state.requests.filter((request) => request.path.endsWith("/notes/from-excerpt"));
  expect(writes()).toHaveLength(1);
  const frozen = writes()[0].payload;
  await draft.getByRole("button", { name: s.contents.excerpt.note.hide, exact: true }).click();
  state.unavailableIds.add(contentId(10001));
  await page.getByRole("button", { name: s.evidence.refresh, exact: true }).click();
  await settle(state);
  await reader.getByRole("button", { name: s.contents.excerpt.note.resume, exact: true }).click();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  expect(await editor.innerText()).toEqual(reviewedBody);
  await expect(draft.getByRole("textbox", { name: s.contents.excerpt.note.title, exact: true })).toBeDisabled();
  const beforeRetry = state.requests.length;
  await draft.getByRole("button", { name: s.contents.excerpt.note.retry, exact: true }).click();
  await expect.poll(() => writes().length).toBe(2);
  expect(writes()[1].payload).toEqual(frozen);
  expect(contentRequests(state, beforeRetry)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("off-window-frozen-retry.png") });
});

test("a finite live burst refreshes only the visible window; authority loss cancels a pending private read", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  const state = await setup(page);
  const reader = await transcript(page);
  const item = reader.locator(`#content-${contentId(10001)}`);
  await item.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(item.getByRole("checkbox")).toBeChecked();
  await reader.getByRole("combobox", { name: s.contents.navigation.label, exact: true }).selectOption(contentId(10001));
  await expect(item).toBeFocused();
  await settle(state);
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  await expect(item).toBeInViewport();
  // Explicit navigation follows the shell's CSS smooth scroll. Focus and network
  // settlement alone do not establish the baseline for a passive-refresh check.
  await expect.poll(() => item.evaluate((element) => new Promise<boolean>((resolve) => {
    const initialTop = element.getBoundingClientRect().top, initialScroll = scrollY;
    let frames = 0;
    const frame = () => {
      if (element.getBoundingClientRect().top !== initialTop || scrollY !== initialScroll) return resolve(false);
      if (++frames === 6) return resolve(true);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }))).toBe(true);
  const beforePosition = await item.boundingBox();
  const beforeScroll = await page.evaluate(() => scrollY);
  const burstStart = state.requests.length;
  state.ownerBurst(20);
  await expect.poll(() => windowRequests(state, burstStart).length).toBe(1);
  await settle(state);
  // Observe a complete second debounce interval: duplicate listeners or an
  // accidental latest-head query must not sneak a later request into the ledger.
  await page.waitForTimeout(2200);
  await settle(state);
  const afterBurst = state.requests.slice(burstStart);
  expect(windowRequests(state, burstStart)).toHaveLength(1);
  expect(windowRequests(state, burstStart)[0]).toMatchObject({ mode: "refresh", returned: 100 });
  expect(afterBurst.filter((request) => request.path === `${contentsPath}/metadata`).length).toBeLessThanOrEqual(1);
  expect(afterBurst.filter((request) => request.path === `${sessionPath}/calls` || request.path === `${sessionPath}/rhythm`)).toEqual([]);
  const support = afterBurst.filter((request) => !request.path.startsWith(contentsPath));
  expect(support.length).toBeLessThanOrEqual(6);
  expect(new Set(support.map((request) => `${request.method} ${request.path}${request.query}`)).size).toBe(support.length);
  expect(byteRequests(state, burstStart)).toEqual([]);
  await expect(item).toBeFocused();
  const afterPosition = await item.boundingBox();
  const afterScroll = await page.evaluate(() => scrollY);
  await test.info().attach("live-refresh-geometry", {
    body: JSON.stringify({ stableFramesBeforeBaseline: 6, beforePosition, afterPosition, beforeScroll, afterScroll }),
    contentType: "application/json",
  });
  expect(Math.abs(afterPosition!.y - beforePosition!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterScroll - beforeScroll)).toBeLessThanOrEqual(1);

  state.holdBody = true;
  await reader.getByRole("button", { name: s.contents.excerpt.preview, exact: true }).click();
  await expect.poll(() => state.held.length).toBe(1);
  const revocationStart = state.requests.length;
  state.authorityStatus = 403;
  state.ownerBurst(20);
  await expect(page.getByRole("heading", { name: s.detail.loadError.title, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: s.contents.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const afterPurge = state.requests.length;
  state.release();
  await settle(state);
  // Measure a complete debounce interval after the private reader is gone.
  await page.waitForTimeout(2200);
  await settle(state);
  const authorityRequests = {
    observationMs: 2200,
    windowGetsDuringRevocation: windowRequests(state, revocationStart).length,
    windowGetsAfterPurge: windowRequests(state, afterPurge).length,
    bodyOrMediaRequestsAfterPurge: byteRequests(state, afterPurge).length,
  };
  await test.info().attach("authority-loss-request-counts", { body: JSON.stringify(authorityRequests), contentType: "application/json" });
  expect(authorityRequests.windowGetsAfterPurge).toBe(0);
  expect(authorityRequests.bodyOrMediaRequestsAfterPurge).toBe(0);
  await expect(page.getByText(bodyText(10001), { exact: true })).toHaveCount(0);
  await expect(page.getByText("SYNTHETIC PREVIEW 10001", { exact: true })).toHaveCount(0);
  await expect.poll(() => state.failures.some((failure) => failure.includes("/body net::ERR_ABORTED"))).toBe(true);
  await page.screenshot({ path: test.info().outputPath("authority-loss.png") });
});
