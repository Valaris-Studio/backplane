// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test, type Page } from "@playwright/test";
import { card, generation, historyEvent, overview, preparation, readyWindow, sequence } from "../src/features/timeline/__tests__/history-fixtures";

test.use({ reducedMotion: "reduce" });
test.setTimeout(30_000);

async function serveHistory(page: Page, preparing = false) {
  let phase = preparing ? "preparing" : "ready";
  const selectors: URLSearchParams[] = [];
  await page.route("**/api/workspaces/test-ws/boards/development/timeline/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname.endsWith("/generations")) body = generation();
    else if (url.pathname.endsWith("/overview")) body = overview();
    else if (url.pathname.endsWith("/retry")) { phase = "ready"; body = preparation(); }
    else if (url.pathname.endsWith("/live-head")) body = { generation_id: generation().id, observed_at: generation().created_at, head_seq: generation().head_seq, state: { columns: readyWindow().anchor.state.columns, cards: [card({ title: "Observed today" })] } };
    else if (url.pathname.endsWith("/search")) body = { generation_id: generation().id, scope: "generation", matches: [{ id: "old-decision", seq: sequence(42), created_at: "2025-02-01T00:00:00Z", summary: "Earlier decision" }], next_cursor: null };
    else if (url.pathname.endsWith("/window")) {
      selectors.push(url.searchParams);
      if (phase === "preparing") { phase = "failed"; body = preparation(); }
      else if (phase === "failed") body = preparation("failed");
      else {
        const offset = url.searchParams.has("at_seq") ? Number(BigInt(url.searchParams.get("at_seq")!) - BigInt(sequence(0))) : url.searchParams.has("at_time") ? 42 : url.searchParams.has("cursor") ? 9995 : 9998;
        const window = readyWindow(offset);
        window.events[0] = historyEvent(offset, { entity_type: "card", entity_id: "card-one", action: "dependency_added", summary: offset === 42 ? "Earlier decision" : "Linked a dependency" });
        body = window;
      }
    } else throw new Error(`Unexpected request ${url}`);
    await route.fulfill({ json: body });
  });
  await page.goto("/e2e/fixtures/timeline-history.html");
  return selectors;
}

for (const width of [375, 1440]) {
  test(`full-span overview, date, global search and observed state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const selectors = await serveHistory(page);
    const overviewRegion = page.getByRole("region", { name: "History overview" });
    await expect(overviewRegion.getByText("10,001 events")).toBeVisible();
    await expect(page.getByTestId("replay-board").getByText("Recorded draft")).toBeVisible();
    await page.getByLabel("Date (UTC)").fill("2025-02-01");
    await page.getByRole("button", { name: "Go to date" }).click();
    await expect.poll(() => selectors.at(-1)?.get("at_time")).toBe("2025-02-01T00:00:00.000Z");
    await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("month");
    await expect(page.getByText(/Selected period:/)).toBeVisible();
    const zoom = page.getByRole("group", { name: "Selected period detail" });
    await expect(zoom.getByRole("button")).toHaveCount(1);
    const zoomBounds = await zoom.boundingBox();
    const bucketBounds = await zoom.getByRole("button").boundingBox();
    expect(bucketBounds!.width).toBeGreaterThan(zoomBounds!.width * 0.99);
    await expect(zoom.getByRole("button")).toHaveAccessibleName(/Jan 1, 2025 to Jan 1, 2026 · 5,000 events/);
    await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("all");
    await expect(page.getByRole("group", { name: "Activity across all history" }).getByRole("button")).toHaveCount(2);
    await page.getByRole("searchbox", { name: "Search all history" }).fill("decision");
    await page.getByRole("searchbox", { name: "Search all history" }).press("Enter");
    await page.getByRole("button", { name: /Earlier decision/ }).click();
    await expect.poll(() => selectors.at(-1)?.get("at_seq")).toBe(sequence(42));
    await page.getByRole("searchbox", { name: /this window/ }).fill("no matching event");
    await expect(page.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2");
    await page.getByRole("button", { name: "Observed board", exact: true }).click();
    await expect(page.getByTestId("replay-board").getByText("Observed today")).toBeVisible();
    await expect(page.getByText(/separate from historical replay/)).toBeVisible();
    await page.getByRole("button", { name: "Return to replay" }).click();
    await expect(page.getByTestId("replay-board").getByText("Recorded draft")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("interrupted preparation retries into the same historical view", async ({ page }) => {
  await serveHistory(page, true);
  await expect(page.getByText("Preparing historical state")).toBeVisible();
  await expect(page.getByText("501 events processed")).toBeVisible();
  await page.getByRole("button", { name: "Observed board", exact: true }).click();
  await expect(page.getByTestId("replay-board").getByText("Observed today")).toBeVisible();
  await page.getByRole("button", { name: "Return to replay" }).click();
  await page.getByRole("button", { name: "Check progress" }).click();
  await expect(page.getByText("Historical preparation interrupted")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("replay-board").getByText("Recorded draft")).toBeVisible();
});
