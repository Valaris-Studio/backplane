// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import { welcomeSeenKey } from "../src/features/dashboard/utils/onboarding-storage";

test.use({
  viewport: { width: 390, height: 844 },
  storageState: process.env.BACKPLANE_E2E_STORAGE_STATE,
});

test("MCP handoff and advanced copy controls fit a narrow dialog", async ({ page }) => {
  const workspace = process.env.BACKPLANE_E2E_WORKSPACE;
  test.skip(!workspace, "Set BACKPLANE_E2E_WORKSPACE to an existing test workspace.");
  await page.route("**/api/me/api-keys", (route) => route.fulfill({ json:
    route.request().method() === "POST" ? {
      id: "browser-key", name: "Browser layout fixture", key_prefix: "fixture",
      created_at: "2026-01-01T00:00:00Z", last_used_at: null,
      raw_key: "synthetic_" + "a".repeat(96),
    } : [],
  }));
  await page.addInitScript((key) => localStorage.setItem(key, "1"), welcomeSeenKey(workspace!));
  await page.goto(`/${workspace}`);
  await page.getByRole("button", { name: "Connect your agent", exact: true }).click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-create-key").click();
  await expect(page.getByTestId("wizard-raw-key")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-agent-message")).toBeVisible();
  const dialog = page.getByRole("dialog");
  const fitsDialog = async () => {
    await expect.poll(async () => dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const bounds = await dialog.boundingBox();
    const copy = await page.getByRole("button", { name: "Copy the message for your agent", exact: true }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(copy).not.toBeNull();
    expect(copy!.x + copy!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  };
  await fitsDialog();
  await page.getByTestId("wizard-advanced-toggle").click();
  await expect(page.getByTestId("wizard-mcp-json")).toBeVisible();
  await fitsDialog();
  await page.getByTestId("wizard-advanced-toggle").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wizard-close-guard")).toBeVisible();
  await page.getByTestId("wizard-close-guard-confirm").click();
  await expect(dialog).not.toBeVisible();
});
