// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`Mermaid math stays readable and contained in ${theme} diagrams`, async ({ page }) => {
    await page.goto(`/e2e/fixtures/mermaid-math.html?theme=${theme}`);
    const diagram = page.getByRole("main", { name: "Math diagram" });
    await expect(diagram.locator("svg")).toBeVisible();
    const math = diagram.locator("math");
    await expect(math).toBeVisible();
    await expect(math.locator("mfrac")).toHaveCount(1);
    await expect(math.locator("msup")).toHaveCount(1);
    const bounds = await math.boundingBox();
    const nodeBounds = await diagram.locator(".node").filter({ has: page.locator("math") }).boundingBox();
    expect(bounds!.width).toBeGreaterThan(20);
    expect(bounds!.height).toBeGreaterThan(10);
    expect(bounds!.x).toBeGreaterThanOrEqual(nodeBounds!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(nodeBounds!.x + nodeBounds!.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(nodeBounds!.y + nodeBounds!.height + 1);
  });
}
