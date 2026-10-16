// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect as baseExpect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ContentBodyPage, SessionContentPage } from "../src/types/agent-session";

// Uses the existing synthetic HTTP fixture, never an authenticated session.
// Start session-excerpt-server.py and Vite with API_URL pointing to that server.
// Run this spec with BACKPLANE_E2E_SESSION_READER_FIXTURE=1 and the fixture's
// BACKPLANE_E2E_BASE_URL; ordinary installed-app acceptance must not run it.
test.skip(process.env.BACKPLANE_E2E_SESSION_READER_FIXTURE !== "1", "Requires the explicitly selected local session-reader fixture.");
test.use({ reducedMotion: "reduce" });
test.setTimeout(30_000);
const expect = baseExpect.configure({ timeout: 1_500 });

async function expandCapturedReply(page: Page) {
  const bodyResponse = () => page.waitForResponse((response) =>
    response.url().includes("/contents/reply-long/body") && response.status() === 200,
  );
  const first = bodyResponse();
  await page.getByRole("button", { name: "Show all (6.5 KB)", exact: true }).click();
  let body: ContentBodyPage = await (await first).json();
  const reply = page.locator("#content-reply-long");
  while (body.next_offset !== null) {
    const next = bodyResponse();
    await reply.getByRole("button", { name: /^Load more \(/ }).click();
    body = await (await next).json();
  }
  await expect(reply).toContainText("FULL BODY TAIL — complete selected evidence.");
}

for (const width of [375, 1024, 1440]) {
  test(`keeps excerpt review and selection count reachable at both ends of a long reader at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light");
    const first = page.getByRole("checkbox", { name: "Select You, source item 1", exact: true });
    await first.press("Space");
    const review = page.getByRole("button", { name: "Preview excerpt", exact: true });
    await expect(review).toBeEnabled();
    await expect(review).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("1 selected from 6 loaded items", { exact: true })).toBeInViewport({ ratio: 1 });

    await expandCapturedReply(page);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    const last = page.getByRole("checkbox", { name: "Select Agent, source item 7", exact: true });
    await expect(last).not.toBeChecked();
    await last.press("Space");
    await expect(last).toBeChecked();
    const count = page.getByText("2 selected from 7 loaded items", { exact: true });
    await expect(count).toBeVisible();
    await testInfo.attach(`last-loaded-item-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    await expect.soft(review, "review remains visible while reading the last selected item").toBeInViewport({ ratio: 1 });
    await expect.soft(count, "selection count remains visible beside the review action").toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await review.press("Enter");
    const preview = page.getByRole("textbox", { name: "Excerpt preview", exact: true });
    await expect(preview).toHaveValue(/Can we preserve the exact selected transcript/);
    await expect(preview).toHaveValue(/The source order is preserved/);
    await expect(preview).not.toHaveValue(/Observation 44/);
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
    await expect(review).toBeInViewport({ ratio: 1 });
    await expect(first).toBeChecked();
    await expect(last).toBeChecked();
    await expect(count).toBeVisible();

    const navigation = page.getByRole("combobox", { name: "Jump to loaded content", exact: true });
    await navigation.selectOption("tool-output");
    const target = page.locator("#content-tool-output");
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport({ ratio: 1 });
    const targetBounds = await target.boundingBox();
    const reviewBounds = await review.boundingBox();
    expect(targetBounds!.y, "the focused source anchor clears the sticky excerpt controls").toBeGreaterThan(reviewBounds!.y + reviewBounds!.height);
    await page.getByRole("button", { name: /Tool call call-fixture/ }).click();
    await navigation.selectOption("tool-output");
    await expect(target).toBeFocused();
    await expect(first).toBeChecked();
    await expect(last).toBeChecked();
  });
}

test.describe("resized loaded-content navigation", () => {
  test.use({ reducedMotion: "no-preference" });

  test("keeps a far source anchor below excerpt actions after a narrow-to-wide resize", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light");
    const first = page.getByRole("checkbox", { name: "Select You, source item 1", exact: true });
    await first.press("Space");
    await expandCapturedReply(page);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    const navigation = page.getByRole("combobox", { name: "Jump to loaded content", exact: true });
    const settled = async (id: string) => page.locator(`#content-${id}`).evaluate(async (target) => {
      const bar = target.closest("section")!.querySelector(".sticky")!;
      let previous = "", stable = 0;
      const frames = [];
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise(requestAnimationFrame);
        const targetBounds = target.getBoundingClientRect();
        const barBounds = bar.getBoundingClientRect();
        const value = { top: targetBounds.top, bottom: targetBounds.bottom, barBottom: barBounds.bottom, scrollY,
          margin: getComputedStyle(target).scrollMarginTop };
        frames.push(value);
        const signature = JSON.stringify(value);
        stable = signature === previous ? stable + 1 : 0;
        previous = signature;
        if (stable >= 4) return { ...value, stable, frames };
      }
      throw new Error("Loaded-content geometry did not settle");
    });
    await navigation.selectOption("prompt");
    await expect(page.locator("#content-prompt")).toBeFocused();
    await settled("prompt");
    await navigation.selectOption("follow-up");
    await expect(page.locator("#content-follow-up")).toBeFocused();
    await settled("follow-up");
    await page.setViewportSize({ width: 640, height: 450 });
    await navigation.selectOption("reply-long");
    const target = page.locator("#content-reply-long");
    await expect(target).toBeFocused();
    const geometry = await settled("reply-long");
    await testInfo.attach("resized-anchor-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect(geometry.top, "the source heading clears the sticky actions after upstream reflow").toBeGreaterThanOrEqual(geometry.barBottom);
    expect(geometry.top).toBeLessThan(450);
    await expect(first).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test.describe("loaded-content navigation beneath the real app header", () => {
  test.use({ reducedMotion: "no-preference" });

  async function prepareHeaderReader(page: Page) {
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me") await route.fulfill({ json: { id: "owner", name: "Fixture owner", email: "owner@example.test", avatar_url: null } });
      else if (path === "/api/auth/modes") await route.fulfill({ json: { oidc_enabled: false, password_enabled: false, dev_mode: false } });
      else if (path === "/api/notifications/unread-count") await route.fulfill({ json: { count: 0 } });
      else if (path === "/api/notifications") await route.fulfill({ json: [] });
      else await route.fallback();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light&chrome=topbar");
    await page.evaluate(() => document.fonts.ready);
    const selected = page.getByRole("checkbox", { name: "Select You, source item 1", exact: true });
    await selected.press("Space");
    await expandCapturedReply(page);
    // Setup may have scrolled the page. Let the real hysteresis/transition
    // return to its expanded state before the first navigation under test.
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, behavior: "instant" });
      const header = document.querySelector("header.sticky")!;
      const inner = header.firstElementChild!;
      const expanded = parseFloat(getComputedStyle(header).getPropertyValue("--topbar-height")) * parseFloat(getComputedStyle(document.documentElement).fontSize);
      let stable = 0;
      for (let frame = 0; frame < 180; frame += 1) {
        window.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
        stable = scrollY === 0 && Math.abs(inner.getBoundingClientRect().height - expanded) < 0.1 ? stable + 1 : 0;
        if (stable >= 4) return;
      }
      throw new Error("App header did not return to its expanded state");
    });
    return selected;
  }

  async function settledHeaderGeometry(target: Locator) {
    return target.evaluate(async (element) => {
      const header = document.querySelector("header.sticky")!;
      const inner = header.firstElementChild!;
      const actions = element.closest("section")!.querySelector(".sticky")!;
      const main = header.nextElementSibling!;
      const expanded = parseFloat(getComputedStyle(header).getPropertyValue("--topbar-height")) * parseFloat(getComputedStyle(document.documentElement).fontSize);
      let previous = "", stable = 0;
      const frames = [];
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise(requestAnimationFrame);
        const value = { top: element.getBoundingClientRect().top, barBottom: actions.getBoundingClientRect().bottom,
          headerHeight: header.getBoundingClientRect().height, innerHeight: inner.getBoundingClientRect().height,
          mainDocumentTop: main.getBoundingClientRect().top + scrollY, scrollY };
        frames.push(value);
        const signature = JSON.stringify(value);
        stable = signature === previous ? stable + 1 : 0;
        previous = signature;
        if (stable >= 4 && value.innerHeight < expanded - 1) return { ...value, frames };
      }
      throw new Error("Compacted app header and loaded-content geometry did not settle");
    });
  }

  test("keeps the first source jump visible while the app header compacts", async ({ page }, testInfo) => {
    const selected = await prepareHeaderReader(page);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.getByRole("combobox", { name: "Jump to loaded content", exact: true }).selectOption("reply-long");
    const target = page.locator("#content-reply-long");
    await expect(target).toBeFocused();
    const geometry = await settledHeaderGeometry(target);
    await testInfo.attach("first-jump-header-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect(geometry.top, "the focused source heading clears the actions after header compaction").toBeGreaterThanOrEqual(geometry.barBottom);
    expect(geometry.top).toBeLessThan(900);
    await expect(selected).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("keeps document flow stable and the compact header's transparent strip click-through", async ({ page }, testInfo) => {
    await prepareHeaderReader(page);
    const before = await page.locator("header.sticky").evaluate((header) => ({
      outerHeight: header.getBoundingClientRect().height,
      innerHeight: header.firstElementChild!.getBoundingClientRect().height,
      mainDocumentTop: header.nextElementSibling!.getBoundingClientRect().top + scrollY,
    }));
    await page.evaluate(() => window.scrollTo({ top: 1000, behavior: "instant" }));
    const after = await settledHeaderGeometry(page.locator("#content-reply-long"));
    const hits = await page.locator("header.sticky").evaluate((header) => {
      const outer = header.getBoundingClientRect();
      const inner = header.firstElementChild!;
      const chrome = inner.getBoundingClientRect();
      const button = inner.querySelector("button")!;
      const control = button.getBoundingClientRect();
      const stripY = (chrome.bottom + outer.bottom) / 2;
      const stripHit = document.elementFromPoint(chrome.left + chrome.width / 2, stripY);
      const controlHit = document.elementFromPoint(control.left + control.width / 2, control.top + control.height / 2);
      return { stripHeight: outer.bottom - chrome.bottom, stripHitsHeader: stripHit !== null && header.contains(stripHit),
        stripHasUnderlyingElement: stripHit !== null, innerControlReceivesHit: controlHit !== null && button.contains(controlHit) };
    });
    await testInfo.attach("header-flow-and-hit-testing", { body: JSON.stringify({ before, after, hits }, null, 2), contentType: "application/json" });
    expect.soft(after.innerHeight).toBeLessThan(before.innerHeight);
    expect.soft(after.mainDocumentTop, "compaction preserves the document coordinates used by source navigation").toBe(before.mainDocumentTop);
    expect.soft(after.headerHeight).toBe(before.outerHeight);
    expect.soft(hits.stripHeight).toBeGreaterThan(0);
    expect.soft(hits.stripHasUnderlyingElement).toBe(true);
    expect.soft(hits.stripHitsHeader, "the transparent compacted strip does not intercept page input").toBe(false);
    expect(hits.innerControlReceivesHit).toBe(true);
  });
});

test("wraps an unbroken captured prose token without widening the mobile reader", async ({ page }, testInfo) => {
  const token = "x".repeat(300);
  let mediaType = "text/plain";
  await page.route("**/sessions/selected-demo/contents**", async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/contents")) return route.fallback();
    const response = await route.fetch();
    const contents = await response.json() as SessionContentPage;
    await route.fulfill({ response, json: { ...contents, items: contents.items.map((item) => item.id === "reply-long"
      ? { ...item, media_type: mediaType, byte_count: token.length, original_byte_count: token.length, coverage: "captured", coverage_reason: null, preview: { text: token, truncated: false } }
      : item) } });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  for (mediaType of ["text/plain", "text/markdown"]) {
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light");
    const reply = page.locator("#content-reply-long");
    await expect(reply.getByText(token, { exact: true })).toBeVisible();
    const geometry = await reply.evaluate((element) => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      rowWidth: element.getBoundingClientRect().width, rowScrollWidth: element.scrollWidth }));
    await testInfo.attach(`unbroken-${mediaType.replace("/", "-")}`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect.soft(geometry.document, `${mediaType} stays within the viewport`).toBeLessThanOrEqual(geometry.viewport);
    expect.soft(geometry.rowScrollWidth, `${mediaType} wraps within its row`).toBeLessThanOrEqual(Math.ceil(geometry.rowWidth));
  }
});

for (const width of [375, 1512]) {
  test(`keeps long tool arguments inside the reader without losing their text at ${width}px`, async ({ page }, testInfo) => {
    const argumentsText = JSON.stringify({ command: "inspect", argument: "synthetic-argument-".repeat(300) + "🧭 END" });
    await page.route("**/sessions/selected-demo/contents**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/contents")) return route.fallback();
      const response = await route.fetch();
      const contents = await response.json() as SessionContentPage;
      await route.fulfill({ response, json: { ...contents, items: contents.items.map((item) => item.id === "tool-input"
        ? { ...item, byte_count: Buffer.byteLength(argumentsText), original_byte_count: Buffer.byteLength(argumentsText), preview: { text: argumentsText, truncated: false } }
        : item) } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light");
    const selected = page.getByRole("checkbox", { name: "Select You, source item 1", exact: true });
    await selected.press("Space");
    const call = page.locator("#content-tool-input");
    const toggle = call.getByRole("button", { name: /^Tool call call-fixture/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const measure = () => call.evaluate((element) => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      rowRight: element.getBoundingClientRect().right, rowWidth: element.getBoundingClientRect().width,
      rowScrollWidth: element.scrollWidth }));
    const closed = await measure();
    await testInfo.attach(`long-tool-summary-${width}`, { body: JSON.stringify(closed, null, 2), contentType: "application/json" });
    expect.soft(closed.document, "the closed argument summary cannot widen the document").toBeLessThanOrEqual(closed.viewport);
    expect.soft(closed.rowRight, "the grouped call stays inside the reader").toBeLessThanOrEqual(closed.viewport);
    await testInfo.attach(`closed-tool-call-${width}`, { body: await page.screenshot(), contentType: "image/png" });

    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await call.locator("pre").first().textContent(), "opening the call retains the exact argument text").toBe(argumentsText);
    const expanded = await measure();
    await testInfo.attach(`expanded-tool-arguments-${width}`, { body: JSON.stringify(expanded, null, 2), contentType: "application/json" });
    expect.soft(expanded.document, "expanded code stays within the reader while retaining its text").toBeLessThanOrEqual(expanded.viewport);
    await page.getByRole("combobox", { name: "Jump to loaded content", exact: true }).selectOption("tool-output");
    await expect(page.locator("#content-tool-output")).toBeFocused();
    await expect(selected).toBeChecked();
    await testInfo.attach(`long-tool-call-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  });
}

async function expectTouchTargets(dialog: Locator, testInfo: TestInfo, state: string) {
  const measurements = await dialog.evaluate((element) => [...element.querySelectorAll("button,a,input,select")]
    .filter((control) => !control.closest('[role="region"]'))
    .map((control) => {
      const bounds = control.getBoundingClientRect();
      return { name: control.getAttribute("aria-label") || control.textContent?.trim() || control.id,
        width: bounds.width, height: bounds.height };
    }));
  await testInfo.attach(state, { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  for (const measurement of measurements) {
    expect.soft(measurement.width, `${state}: ${measurement.name} touch width`).toBeGreaterThanOrEqual(44);
    expect.soft(measurement.height, `${state}: ${measurement.name} touch height`).toBeGreaterThanOrEqual(44);
  }
  const heading = await dialog.getByRole("heading").boundingBox();
  const close = await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox();
  expect(heading).not.toBeNull();
  expect(close).not.toBeNull();
  expect.soft(heading!.x + heading!.width <= close!.x || heading!.y >= close!.y + close!.height,
    `${state}: the enlarged close control does not cover the heading`).toBe(true);
}

async function serveNoteDestinations(page: Page) {
  const workspace = { id: "destination", slug: "touch-targets", name: "Touch target team" };
  const board = { id: "board", workspace_id: workspace.id, name: "Handoff", is_frozen: false };
  const card = { id: "card", title: "Continue reviewed work" };
  let response: "rejected" | "saved" = "rejected";
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/sessions/selected-demo/contents")) {
      const actual = await route.fetch();
      const contents = await actual.json() as SessionContentPage;
      await route.fulfill({ response: actual, json: { ...contents, items: contents.items.map((item) => ({ ...item, sha256: "a".repeat(64) })) } });
    } else if (pathname === "/api/workspaces") await route.fulfill({ json: [workspace] });
    else if (pathname === "/api/me") await route.fulfill({ json: { id: "owner", name: "Owner", email: "owner@example.test" } });
    else if (pathname.endsWith("/members")) await route.fulfill({ json: [{ user_id: "owner", role: "owner" }] });
    else if (pathname === "/api/workspaces/touch-targets/boards") await route.fulfill({ json: [board] });
    else if (pathname === "/api/workspaces/touch-targets/boards/board") await route.fulfill({ json: { ...board, columns: [{ id: "todo", cards: [card] }] } });
    else if (pathname.endsWith("/notes/from-excerpt")) await route.fulfill(response === "rejected"
      ? { status: 403, json: { detail: "Synthetic destination refusal" } }
      : { status: 201, json: { id: "saved-note" } });
    else await route.fallback();
  });
  return { saveNext: () => { response = "saved"; } };
}

for (const width of [375, 639]) {
  test(`provides 44px touch targets for excerpt selection and actions at ${width}px`, async ({ page }, testInfo) => {
    const destination = await serveNoteDestinations(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/e2e/fixtures/session-excerpt.html?locale=en&theme=light");
    const first = page.getByRole("checkbox", { name: "Select You, source item 1", exact: true });
    const selectionTarget = page.locator("label").filter({ has: first });
    await expect(selectionTarget).toBeVisible();
    await selectionTarget.scrollIntoViewIfNeeded();
    const selectionBounds = await selectionTarget.boundingBox();
    expect(selectionBounds).not.toBeNull();
    // The native input is visually hidden; its associated label is the touch target.
    await selectionTarget.click({ position: { x: selectionBounds!.width - 2, y: selectionBounds!.height / 2 } });
    await expect(first).toBeChecked();
    const targets = [
      { name: "Excerpt selection", control: selectionTarget },
      { name: "Clear selection", control: page.getByRole("button", { name: "Clear selection", exact: true }) },
      { name: "Preview excerpt", control: page.getByRole("button", { name: "Preview excerpt", exact: true }) },
      { name: "Jump to loaded content", control: page.getByRole("combobox", { name: "Jump to loaded content", exact: true }) },
    ];
    const measurements = [];
    for (const { name, control } of targets) {
      await expect(control).toBeEnabled();
      const bounds = await control.boundingBox();
      expect(bounds, `${name} has a rendered hit area`).not.toBeNull();
      measurements.push({ name, width: bounds!.width, height: bounds!.height });
      expect.soft(bounds!.width, `${name} touch width`).toBeGreaterThanOrEqual(44);
      expect.soft(bounds!.height, `${name} touch height`).toBeGreaterThanOrEqual(44);
    }
    await testInfo.attach(`touch-targets-${width}`, { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
    await page.getByRole("button", { name: "Preview excerpt", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Selected excerpt", exact: true });
    await expect(preview.getByRole("textbox", { name: "Excerpt preview", exact: true })).toBeVisible();
    await expectTouchTargets(preview, testInfo, "private-preview");
    await preview.getByRole("button", { name: "Share as note", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "Share as note", exact: true });
    await draft.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("touch-targets");
    await draft.getByRole("combobox", { name: "Board", exact: true }).selectOption("board");
    await draft.getByRole("combobox", { name: "Card (optional)", exact: true }).selectOption("card");
    await expect(draft.getByRole("button", { name: "Save note", exact: true })).toBeEnabled();
    await expectTouchTargets(draft, testInfo, "unsent-note");
    await draft.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(draft.getByRole("button", { name: "Revise draft", exact: true })).toBeVisible();
    await expectTouchTargets(draft, testInfo, "rejected-note");
    destination.saveNext();
    await draft.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(draft.getByRole("link", { name: "Open note", exact: true })).toBeVisible();
    await expectTouchTargets(draft, testInfo, "confirmed-note");
    const close = draft.getByRole("button", { name: "Close", exact: true });
    await close.scrollIntoViewIfNeeded();
    const closeBounds = await close.boundingBox();
    expect(closeBounds).not.toBeNull();
    await close.click({ position: { x: closeBounds!.width - 2, y: closeBounds!.height / 2 } });
    await expect(draft).toHaveCount(0);
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(first).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Preview excerpt", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
