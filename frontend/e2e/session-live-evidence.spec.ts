// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import {
  boardId, bodyText, byteRequests, cardId, contentId, contentRequests,
  installWindowFixture, records, routePath, session, sessionPath, sha, slug, windowRequests, work, type WindowFixture,
} from "./fixtures/session-window-fixture";

test.skip(process.env.BACKPLANE_E2E_SESSION_LIVE_FIXTURE !== "1", "Set BACKPLANE_E2E_SESSION_LIVE_FIXTURE=1 for synthetic AppShell acceptance");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });
test.setTimeout(45_000);
const states = new Map<Page, WindowFixture>();
const inputHashes = () => Object.fromEntries(["e2e/session-live-evidence.spec.ts", "e2e/fixtures/session-window-fixture.ts", "src/features/sessions/api/use-session-realtime.ts", "src/hooks/useDomainSync.ts", "src/lib/websocket.ts"].map((path) => [path, sha(readFileSync(path))]));
const startingInputs = new Map<Page, ReturnType<typeof inputHashes>>();
const s = en.sessions;
const labelsByLocale = { en, es, "pt-BR": pt };
type Locale = keyof typeof labelsByLocale;
const targetTitle = "Review this bounded evidence";

test.afterEach(async ({ page }, info) => {
  const state = states.get(page);
  if (!state) return;
  state.release();
  const ledger = info.outputPath("live-evidence-ledger.json");
  writeFileSync(ledger, JSON.stringify({
      dataset: records.length, browser: page.context().browser()?.version(),
      inputsBefore: startingInputs.get(page), inputs: inputHashes(),
      requests: state.requests, sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected,
    }, null, 2));
  await info.attach("live-evidence-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("final-shell.png") });
  if (info.status === info.expectedStatus) expect(state.unexpected).toEqual([]);
  states.delete(page);
  startingInputs.delete(page);
});

async function settle(state: WindowFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

async function setup(page: Page, locale: Locale = "en", width = 1440, prepare?: (state: WindowFixture) => void) {
  await page.setViewportSize({ width, height: 1000 });
  startingInputs.set(page, inputHashes());
  const state = await installWindowFixture(page, locale);
  states.set(page, state);
  prepare?.(state);
  await page.goto(routePath);
  await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  await settle(state);
  return state;
}

async function inspect(page: Page, relation: "changed" | "consulted", locale: Locale = "en") {
  const labels = labelsByLocale[locale].sessions;
  if (page.viewportSize()!.width < 1280) await page.getByRole("tab", { name: labels.detail.tabs.details, exact: true }).click();
  const name = labels.evidence.inspectLabel.replace("{{relation}}", labels.work[relation]).replace("{{title}}", targetTitle);
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name: labels.detail.tabs.timeline, exact: true })).toHaveAttribute("aria-selected", "true");
  return page.getByRole("region", { name: labels.evidence.title.replace("{{title}}", targetTitle), exact: true });
}

const sessionRequests = (state: WindowFixture, since: number) => state.requests.slice(since).filter((request) => request.path.startsWith(`/api/workspaces/${slug}/sessions`));

async function transcript(page: Page) {
  await page.getByRole("tab", { name: s.contents.title, exact: true }).click();
  const reader = page.getByRole("region", { name: s.contents.title, exact: true });
  await expect(reader).toBeVisible();
  return reader;
}

for (const [locale, width] of [["en", 1440], ["es", 375], ["pt-BR", 1024]] as const) {
  test(`${locale} ${width}: late links, exact replacement and retraction keep Inspect truthful`, async ({ page }) => {
    const labels = labelsByLocale[locale].sessions;
    const state = await setup(page, locale, width, (fixture) => {
      fixture.links = [work("exact", "changed")];
      fixture.calls.find((call) => call.key === "correlated")!.work_refs = [];
    });
    if (width < 1280) await page.getByRole("tab", { name: labels.detail.tabs.details, exact: true }).click();
    const consultedName = labels.evidence.inspectLabel.replace("{{relation}}", labels.work.consulted).replace("{{title}}", targetTitle);
    await expect(page.getByRole("button", { name: consultedName, exact: true })).toHaveCount(0);
    await settle(state);
    const ignoredStart = state.requests.length;
    state.eventBurst(20, "another-owner");
    await page.waitForTimeout(2200);
    await settle(state);
    expect(sessionRequests(state, ignoredStart)).toEqual([]);

    state.links.push(work("correlated", "consulted"));
    state.calls.find((call) => call.key === "correlated")!.work_refs = [work("correlated", "consulted")];
    const lateStart = state.requests.length;
    state.ownerBurst(20);
    const lastEventAt = state.socketLedger.at(-1)!.at;
    await expect(page.getByRole("button", { name: consultedName, exact: true })).toBeVisible();
    await settle(state);
    const lateLinks = sessionRequests(state, lateStart).filter((request) => request.path.endsWith("/links"));
    expect(lateLinks).toHaveLength(1);
    expect(lateLinks[0].startedAt - lastEventAt).toBeGreaterThanOrEqual(1900);
    const evidence = await inspect(page, "consulted", locale);
    await expect(evidence.getByText(labels.evidence.correlated, { exact: true })).toBeVisible();
    await expect(evidence.getByText(labels.evidence.exact, { exact: true })).toHaveCount(0);
    await expect(evidence.getByText("Unmatched evidence", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("late-correlated-inspect.png") });

    state.links = [work("exact", "changed"), work("exact", "consulted")];
    state.calls.find((call) => call.key === "correlated")!.work_refs = [work("exact", "consulted")];
    const replacementStart = state.requests.length;
    state.ownerBurst(20);
    await expect(evidence.getByText(labels.evidence.exact, { exact: true })).toBeVisible();
    await expect(evidence.getByText(labels.evidence.correlated, { exact: true })).toHaveCount(0);
    await settle(state);
    expect(sessionRequests(state, replacementStart).filter((request) => request.path.endsWith("/links"))).toHaveLength(1);
    await expect(page.getByRole("tab", { name: labels.detail.tabs.timeline, exact: true })).toHaveAttribute("aria-selected", "true");

    state.calls.find((call) => call.key === "correlated")!.work_refs = [];
    state.ownerBurst(20);
    await expect(evidence.getByText(labels.evidence.empty, { exact: true })).toBeVisible();
    await expect(evidence.getByText(labels.evidence.exact, { exact: true })).toHaveCount(0);
    state.links = [work("exact", "changed")];
    const retractionStart = state.requests.length;
    state.ownerBurst(20);
    await expect(page.getByText(labels.evidence.missing, { exact: true })).toBeVisible();
    await settle(state);
    await page.waitForTimeout(2200);
    await settle(state);
    expect(sessionRequests(state, retractionStart).filter((request) => request.path.endsWith("/links"))).toHaveLength(1);
    expect(byteRequests(state)).toEqual([]);
    expect(contentRequests(state)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole("button", { name: labels.evidence.return, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("retracted-inspect.png") });
    await page.getByRole("button", { name: labels.evidence.return, exact: true }).click();
    const changed = await inspect(page, "changed", locale);
    await expect(changed.getByText(labels.evidence.exact, { exact: true })).toBeVisible();
    await expect(changed.getByText(labels.evidence.correlated, { exact: true })).toHaveCount(0);
  });
}

for (const [hasOwnerEvent, width] of [[true, 1440], [false, 375]] as const) {
  test(`first-load identity ${width}: ${hasOwnerEvent ? "recovers the owner's update" : "ignores another owner's update"}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    startingInputs.set(page, inputHashes());
    const state = await installWindowFixture(page);
    states.set(page, state);
    let releaseIdentity!: () => void;
    const identity = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    await page.route("**/api/me", async (route) => {
      state.socketLedger.push({ kind: "identity-held", at: Date.now(), connection: state.socketsOpened });
      await identity;
      await route.fallback();
    });
    try {
      await page.goto(routePath);
      await expect(page.getByRole("heading", { name: session.title!, exact: true })).toBeVisible();
      await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
      await expect.poll(() => state.socketLedger.some((entry) => entry.kind === "identity-held")).toBe(true);
      const evidence = await inspect(page, "consulted");
      await expect(evidence.getByText(s.evidence.correlated, { exact: true })).toBeVisible();
      await settle(state);
      const start = state.requests.length;
      const connections = state.socketsOpened;
      state.links = [];
      state.calls.forEach((call) => { call.work_refs = []; });
      if (hasOwnerEvent) state.ownerBurst(20);
      state.eventBurst(20, "another-owner");
      await page.waitForTimeout(2200);
      expect(sessionRequests(state, start)).toEqual([]);
      state.socketLedger.push({ kind: "identity-released", at: Date.now(), connection: state.socketsOpened });
      releaseIdentity();
      await expect.poll(() => state.requests.some((request) => request.path === "/api/me" && request.status === 200)).toBe(true);
      if (hasOwnerEvent) {
        await expect(page.getByText(s.evidence.missing, { exact: true })).toBeVisible();
        await settle(state);
        expect(sessionRequests(state, start).filter((request) => request.path.endsWith("/links"))).toHaveLength(1);
        await expect(page.getByRole("button", { name: s.evidence.return, exact: true })).toBeVisible();
      } else {
        await page.waitForTimeout(2200);
        await settle(state);
        expect(sessionRequests(state, start)).toEqual([]);
        await expect(evidence.getByText(s.evidence.correlated, { exact: true })).toBeVisible();
      }
      expect(state.socketsOpened).toBe(connections);
      expect(byteRequests(state)).toEqual([]);
      expect(contentRequests(state)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("identity-recovery.png") });
    } finally {
      releaseIdentity();
    }
  });
}

test("reconnect recovers a missed retraction from durable reads without a new event", async ({ page }) => {
  const state = await setup(page);
  const evidence = await inspect(page, "consulted");
  await expect(evidence.getByText(s.evidence.correlated, { exact: true })).toBeVisible();
  await settle(state);
  await page.screenshot({ path: test.info().outputPath("before-missed-retraction.png") });
  const start = state.requests.length;
  const connections = state.socketsOpened;
  await state.disconnect();
  state.links = [];
  state.calls.forEach((call) => { call.work_refs = []; });
  await expect.poll(() => state.socketsOpened).toBe(connections + 1);
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  expect(state.socketLedger.filter((entry) => entry.kind === "event")).toEqual([]);
  await expect(page.getByText(s.evidence.missing, { exact: true })).toBeVisible({ timeout: 5000 });
  await settle(state);
  expect(state.requests.slice(start).filter((request) => request.path === `${sessionPath}/links`)).toHaveLength(1);
  expect(byteRequests(state)).toEqual([]);
  await expect(page.getByRole("button", { name: s.evidence.return, exact: true })).toBeVisible();
  await expect(page.getByText(s.evidence.correlated, { exact: true })).toHaveCount(0);
});

test("historical selection and an edited frozen handoff survive events and reconnect", async ({ page }) => {
  const state = await setup(page);
  await inspect(page, "consulted");
  const reader = await transcript(page);
  await reader.locator(`#content-${contentId(10001)}`).locator("label").click();
  await reader.getByRole("button", { name: "Beginning", exact: true }).click();
  await reader.locator(`#content-${contentId(1)}`).locator("label").click();
  await reader.getByRole("button", { name: "Later records", exact: true }).click();
  await expect(reader.locator(`#content-${contentId(200)}`)).toBeVisible();
  await expect(reader.locator(`#content-${contentId(10001)}`)).toHaveCount(0);
  expect(byteRequests(state)).toEqual([]);
  await reader.getByRole("button", { name: s.contents.excerpt.preview, exact: true }).click();
  const preview = page.getByRole("dialog", { name: s.contents.excerpt.title, exact: true });
  await expect(preview.getByRole("textbox", { name: s.contents.excerpt.previewLabel, exact: true })).toHaveValue(new RegExp(bodyText(10001)));
  await preview.getByRole("button", { name: s.contents.excerpt.note.share, exact: true }).click();
  const draft = page.getByRole("dialog", { name: s.contents.excerpt.note.share, exact: true });
  await draft.getByRole("textbox", { name: s.contents.excerpt.note.title, exact: true }).fill("Synthetic edited live-evidence handoff");
  await draft.getByRole("combobox", { name: /^Workspace/ }).selectOption(slug);
  await draft.getByRole("combobox", { name: /^Board/ }).selectOption(boardId);
  await draft.getByRole("combobox", { name: /^Card/ }).selectOption(cardId);
  const editor = draft.getByRole("region", { name: s.contents.excerpt.note.content, exact: true }).locator("[contenteditable]");
  const edited = "Operator-reviewed synthetic continuation: preserve this exact edited draft.";
  await editor.fill(edited);
  const editedRefreshStart = state.requests.length;
  state.links = [work("exact", "changed")];
  state.calls.find((call) => call.key === "correlated")!.work_refs = [];
  state.ownerBurst(20);
  await expect.poll(() => windowRequests(state, editedRefreshStart).length).toBe(1);
  await settle(state);
  await expect(editor).toHaveText(edited);
  await expect(draft.getByRole("textbox", { name: s.contents.excerpt.note.title, exact: true })).toHaveValue("Synthetic edited live-evidence handoff");
  expect(byteRequests(state, editedRefreshStart)).toEqual([]);
  await draft.getByRole("button", { name: s.contents.excerpt.note.save, exact: true }).click();
  await expect(draft.getByRole("alert")).toContainText("may have been saved");
  const writes = () => state.requests.filter((request) => request.path.endsWith("/notes/from-excerpt"));
  expect(writes()).toHaveLength(1);
  const frozen = writes()[0].payload;
  await draft.getByRole("button", { name: s.contents.excerpt.note.hide, exact: true }).click();
  const historical = reader.locator(`#content-${contentId(101)}`);
  await reader.getByRole("combobox", { name: s.contents.navigation.label, exact: true }).selectOption(contentId(101));
  await expect(historical).toBeFocused();
  await settle(state);
  await expect.poll(() => historical.evaluate((element) => new Promise<boolean>((resolve) => {
    const top = element.getBoundingClientRect().top, initialScroll = scrollY;
    let frames = 0;
    const frame = () => {
      if (element.getBoundingClientRect().top !== top || scrollY !== initialScroll) return resolve(false);
      if (++frames === 6) return resolve(true);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }))).toBe(true);
  const before = { box: await historical.boundingBox(), scrollY: await page.evaluate(() => scrollY) };
  const refreshStart = state.requests.length;
  state.ownerBurst(20);
  await expect.poll(() => windowRequests(state, refreshStart).length).toBe(1);
  await settle(state);
  await page.waitForTimeout(2200);
  await settle(state);
  const refreshed = windowRequests(state, refreshStart);
  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]).toMatchObject({ mode: "refresh", cursor: "window:101:200", returned: 100 });
  expect(byteRequests(state, refreshStart)).toEqual([]);
  await expect(historical).toBeFocused();
  const after = { box: await historical.boundingBox(), scrollY: await page.evaluate(() => scrollY) };
  expect(Math.abs(after.box!.y - before.box!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
  await test.info().attach("historical-refresh-geometry", { body: JSON.stringify({ before, after }), contentType: "application/json" });
  await reader.getByRole("button", { name: s.contents.excerpt.note.resume, exact: true }).click();
  await expect(editor).toHaveText(edited);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await draft.getByRole("button", { name: s.contents.excerpt.note.hide, exact: true }).click();
  await reader.getByRole("combobox", { name: s.contents.navigation.label, exact: true }).selectOption(contentId(101));
  await expect(historical).toBeFocused();
  await settle(state);
  await expect.poll(() => historical.evaluate((element) => new Promise<boolean>((resolve) => {
    const top = element.getBoundingClientRect().top, initialScroll = scrollY;
    let frames = 0;
    const frame = () => {
      if (element.getBoundingClientRect().top !== top || scrollY !== initialScroll) return resolve(false);
      if (++frames === 6) return resolve(true);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }))).toBe(true);
  const beforeReconnect = { box: await historical.boundingBox(), scrollY: await page.evaluate(() => scrollY) };
  state.unavailableIds.add(contentId(10001));
  const frozenRefreshStart = state.requests.length;
  const frozenSocketStart = state.socketLedger.length;
  const connections = state.socketsOpened;
  await state.disconnect();
  await expect.poll(() => state.socketsOpened).toBe(connections + 1);
  await expect.poll(() => state.subscriptions.includes("agent_session.*")).toBe(true);
  expect(state.socketLedger.slice(frozenSocketStart).filter((entry) => entry.kind === "event")).toEqual([]);
  await expect.poll(() => windowRequests(state, frozenRefreshStart).length).toBe(1);
  await settle(state);
  expect(windowRequests(state, frozenRefreshStart)[0]).toMatchObject({ mode: "refresh", cursor: "window:101:200", returned: 100 });
  expect(byteRequests(state, frozenRefreshStart)).toEqual([]);
  await expect(historical).toBeFocused();
  const afterReconnect = { box: await historical.boundingBox(), scrollY: await page.evaluate(() => scrollY) };
  for (const dimension of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(afterReconnect.box![dimension] - beforeReconnect.box![dimension])).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(afterReconnect.scrollY - beforeReconnect.scrollY)).toBeLessThanOrEqual(1);
  await test.info().attach("historical-reconnect-geometry", { body: JSON.stringify({ before: beforeReconnect, after: afterReconnect }), contentType: "application/json" });
  await reader.getByRole("button", { name: s.contents.excerpt.note.resume, exact: true }).click();
  await expect(editor).toHaveText(edited);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  const retryStart = state.requests.length;
  await draft.getByRole("button", { name: s.contents.excerpt.note.retry, exact: true }).click();
  await expect.poll(() => writes().length).toBe(2);
  expect(writes()[1].payload).toEqual(frozen);
  expect(contentRequests(state, retryStart)).toEqual([]);
  expect(byteRequests(state)).toHaveLength(2);
  expect(windowRequests(state).every((request) => request.returned === 100)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("historical-frozen-draft.png") });
  await draft.getByRole("button", { name: s.contents.excerpt.note.hide, exact: true }).click();
  await page.getByRole("tab", { name: s.detail.tabs.timeline, exact: true }).click();
  await expect(page.getByText(s.evidence.missing, { exact: true })).toBeVisible();
});

test("access loss purges private descendants before held responses can return", async ({ page }) => {
  const state = await setup(page, "en", 375);
  const reader = await transcript(page);
  await reader.locator(`#content-${contentId(10001)}`).locator("label").click();
  expect(byteRequests(state)).toEqual([]);
  state.holdBody = true;
  await reader.getByRole("button", { name: s.contents.excerpt.preview, exact: true }).click();
  await expect.poll(() => state.held.length).toBe(1);
  state.holdWindow = true;
  state.authorityStatus = 403;
  state.ownerBurst(20);
  await expect(page.getByRole("heading", { name: s.detail.loadError.title, exact: true })).toBeVisible();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const purge = state.requests.length;
  state.release();
  await settle(state);
  await page.waitForTimeout(2200);
  await settle(state);
  expect(contentRequests(state, purge)).toEqual([]);
  await expect(page.getByText("SYNTHETIC PREVIEW 10001", { exact: true })).toHaveCount(0);
  await expect(page.getByText(bodyText(10001), { exact: true })).toHaveCount(0);
  await expect.poll(() => state.failures.some((failure) => failure.endsWith("/body net::ERR_ABORTED"))).toBe(true);
  expect(byteRequests(state)).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("access-loss-after-late-response.png") });
});
