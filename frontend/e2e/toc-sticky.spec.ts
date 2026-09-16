// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page } from "@playwright/test";

/**
 * Card e78d1b43 — the desktop documentation TOC must actually stick.
 *
 * The jsdom suites pin the class-level contract (no overflow on AppShell's
 * <main>, no self-start on the docs aside); this spec pins the observable
 * behavior in a real layout engine: after wheel-scrolling well past the
 * sticky offset, the TOC holds its viewport position instead of riding the
 * scroll — on both hosts (standalone /documentation and the in-app
 * workspace shell). Requires the running dev stack (`make dev` — frontend
 * 5173, backend 8000) like the rest of e2e/.
 */

const API_BASE = process.env.BACKPLANE_E2E_API_URL ?? "http://localhost:8000";
const DEV_AUTH = { "X-User-Email": "dev@valaris.dev" };

const SCROLL_WHEEL_PX = 900;
// Guards a false green on short content: the sticky assertion only means
// something if the window really scrolled several hundred px.
const MIN_WINDOW_SCROLL_PX = 400;
// Sticky engaged = TOC viewport position unchanged bar sub-pixel noise.
const STICKY_TOLERANCE_PX = 4;
// The pinned position derives from CSS vars (--topbar-height); allow a few px
// of rounding between boundingBox and the computed `top`.
const PIN_OFFSET_TOLERANCE_PX = 4;

// At scrollY=0 the TOC sits in normal flow ~112px BELOW its sticky pin offset
// and must ride up that gap before pinning, so both measurements are taken
// past the engage point: baseline after one wheel delta, drift after a second.
// Working sticky drifts ~0 between the two; broken sticky rides the full
// wheel delta (~900px).
async function measureTocUnderScroll(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  const toc = page.locator("[data-toc-scroll]");
  await expect(toc).toBeVisible();
  await page.waitForTimeout(1000); // let the page entry animation settle

  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, SCROLL_WHEEL_PX);
  await page.waitForTimeout(500);

  const before = await toc.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.wheel(0, SCROLL_WHEEL_PX);
  await page.waitForTimeout(500);

  const after = await toc.boundingBox();
  expect(after).not.toBeNull();
  const windowScrollY = await page.evaluate(() => window.scrollY);
  const stickyTopPx = await toc.evaluate(
    (el) => Number.parseFloat(getComputedStyle(el).top),
  );

  return { before: before!, after: after!, windowScrollY, stickyTopPx };
}

test("TOC sticks on the standalone /documentation route", async ({ page }) => {
  const { before, after, windowScrollY, stickyTopPx } =
    await measureTocUnderScroll(page, "/documentation/loop-mode");

  expect(windowScrollY).toBeGreaterThan(MIN_WINDOW_SCROLL_PX);
  expect(Math.abs(after.y - before.y)).toBeLessThan(STICKY_TOLERANCE_PX);
  // Second pin: pinned means sitting AT the declared sticky offset, not
  // merely drifting slowly.
  expect(Math.abs(after.y - stickyTopPx)).toBeLessThan(PIN_OFFSET_TOLERANCE_PX);
});

test("TOC sticks inside the AppShell host and the WINDOW carries the scroll", async ({
  page,
  request,
}) => {
  const slug = `toc-sticky-${Date.now()}`;
  const created = await request.post(`${API_BASE}/api/workspaces`, {
    headers: DEV_AUTH,
    data: { name: slug, slug },
  });
  expect(created.ok(), await created.text()).toBe(true);

  try {
    const { before, after, windowScrollY, stickyTopPx } =
      await measureTocUnderScroll(page, `/${slug}/documentation/loop-mode`);

    // The shell is window-scrolled by design — if the wheel delta landed in
    // some inner scrollport instead (e.g. an overflow:auto <main>), this
    // fails before the sticky assertion does.
    expect(windowScrollY).toBeGreaterThan(MIN_WINDOW_SCROLL_PX);
    expect(Math.abs(after.y - before.y)).toBeLessThan(STICKY_TOLERANCE_PX);
    // Second pin: pinned means sitting AT the declared sticky offset, not
    // merely drifting slowly.
    expect(Math.abs(after.y - stickyTopPx)).toBeLessThan(
      PIN_OFFSET_TOLERANCE_PX,
    );
  } finally {
    await request.delete(`${API_BASE}/api/workspaces/${slug}`, {
      headers: DEV_AUTH,
    });
  }
});
