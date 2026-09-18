// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";

// A production stack requires a saved authenticated session; dev auth needs none.
test.use({ storageState: process.env.BACKPLANE_E2E_STORAGE_STATE });

test("resource uploads persist bytes and never register rejected files", async ({ page }) => {
  const workspaceSlug = `upload-gate-${Date.now()}`;
  const created = await page.request.post("/api/workspaces", {
    data: { name: workspaceSlug, slug: workspaceSlug },
  });
  expect(created.status()).toBe(201);
  const { slug } = await created.json();
  const resourcesPath = `/api/workspaces/${slug}/resources`;

  try {
    await page.addInitScript(() => localStorage.setItem("i18n-lang", "en"));
    await page.goto(`/${slug}/resources`);
    const input = page.locator('input[type="file"]');
    await expect(input).toBeAttached();

    for (const size of [2, 25]) {
      const name = `accepted-${size}mib.txt`;
      const bytes = Buffer.alloc(size * 1024 * 1024, "a");
      const saved = page.waitForResponse((response) =>
        response.url().endsWith(resourcesPath) && response.request().method() === "POST",
      );
      await input.setInputFiles({ name, mimeType: "text/plain", buffer: bytes });
      const response = await saved;
      expect(response.status()).toBe(201);
      const resource = await response.json();
      const signed = await page.request.get(`${resourcesPath}/${resource.id}/download-url`);
      expect(signed.ok()).toBe(true);
      const download = await page.request.get((await signed.json()).download_url);
      expect(download.ok()).toBe(true);
      expect(Buffer.compare(await download.body(), bytes)).toBe(0);
    }

    const resourceCreates: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(resourcesPath) && request.method() === "POST") {
        resourceCreates.push(request.url());
      }
    });
    await input.setInputFiles({
      name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole("alert")).toHaveText(
      "The file exceeds the upload limit. Choose a smaller file and try again.",
    );
    expect(resourceCreates).toHaveLength(0);

    await page.route("**/api/local-storage/upload/**", (route) =>
      route.fulfill({ status: 500, contentType: "text/html", body: "Storage unavailable" }),
    );
    const retryFile = { name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry bytes") };
    await input.setInputFiles(retryFile);
    await expect(page.getByRole("alert")).toHaveText("The file could not be uploaded. Please try again.");
    expect(resourceCreates).toHaveLength(0);
    expect((await (await page.request.get(resourcesPath)).json())).toHaveLength(2);

    await page.unroute("**/api/local-storage/upload/**");
    const retried = page.waitForResponse((response) =>
      response.url().endsWith(resourcesPath) && response.request().method() === "POST",
    );
    await input.setInputFiles(retryFile);
    expect((await retried).status()).toBe(201);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(resourceCreates).toHaveLength(1);
  } finally {
    const removed = await page.request.delete(`/api/workspaces/${slug}`);
    expect(removed.status()).toBe(204);
  }
});
