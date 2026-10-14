// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test, type Locator } from "@playwright/test";

// Uses the Vite-served fixture and production component/CSS; no backend is needed.
const FIXTURE = "/e2e/fixtures/timeline-scrubber.html";
const SUBPIXEL_TOLERANCE = 0.5;

test.use({ reducedMotion: "reduce" });
test.setTimeout(30_000);

async function expectInsideScrollport(target: Locator, scrollport: Locator, label: string) {
  const bounds = await target.boundingBox();
  expect(bounds, label).not.toBeNull();
  const viewport = await scrollport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left + element.clientLeft, right: rect.left + element.clientLeft + element.clientWidth };
  });
  expect.soft(bounds!.x, `${label}: left edge`).toBeGreaterThanOrEqual(viewport.left - SUBPIXEL_TOLERANCE);
  expect.soft(bounds!.x + bounds!.width, `${label}: right edge`).toBeLessThanOrEqual(viewport.right + SUBPIXEL_TOLERANCE);
}

for (const width of [375, 1440]) {
  test(`context markers and count badges stay inside the board at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(FIXTURE);
    const scrollport = page.getByTestId("board-scrollport");
    const markers = page.getByTestId("scrubber-context-event");
    await expect(markers).toHaveCount(3);
    await expect(markers.first()).toHaveAccessibleName(/3 events/);
    await expect(markers.last()).toHaveAccessibleName(/3 events/);

    for (const [name, marker] of [["first", markers.first()], ["last", markers.last()]] as const) {
      await expectInsideScrollport(marker, scrollport, `${name} button`);
      await expectInsideScrollport(marker.locator("span").filter({ hasText: /^3$/ }), scrollport, `${name} count`);
    }

    // All lanes must still locate the same event on the same horizontal axis.
    const flags = page.getByTestId("scrubber-flag-dot");
    for (let index = 0; index < 3; index += 1) {
      const marker = await markers.nth(index).boundingBox();
      const flag = await flags.nth(index).boundingBox();
      expect(Math.abs(marker!.x + marker!.width / 2 - flag!.x - flag!.width / 2)).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE);
    }

    await markers.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("slider")).toHaveValue("0");
    await page.keyboard.press("Space");
    await expect(page.getByRole("slider")).toHaveValue("1");
    await markers.last().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("slider")).toHaveValue("997");
  });
}

test("a single note remains visible and keyboard reachable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${FIXTURE}?single`);
  const marker = page.getByTestId("scrubber-context-event");
  await expect(marker).toBeVisible();
  await expectInsideScrollport(marker, page.getByTestId("board-scrollport"), "only button");
  await page.getByRole("slider").focus();
  await page.keyboard.press("Tab");
  await expect(marker).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(marker).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("slider")).toHaveValue("0");
});
