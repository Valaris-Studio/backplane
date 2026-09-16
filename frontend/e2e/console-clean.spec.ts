// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page } from "@playwright/test";
import { ConsoleCollector } from "./console-collector";

/**
 * Browser-level acceptance gate: the core workspace/board lifecycle must run
 * without writing anything to the console that isn't on the by-design
 * allowlist (see console-collector.ts). Requires a running dev stack.
 *
 * One serial file so state flows naturally: each flow builds on the previous
 * one's result, and the run cleans up the workspace it created.
 */

const stamp = Date.now();
const workspaceName = `gate-${stamp}`;
const workspaceSlug = workspaceName; // the dialog derives an identical slug
const boardName = `gate-board-${stamp}`;

let page: Page;
let collector: ConsoleCollector;

/**
 * The shared DialogContent carries no role/testid, and its portal to <body>
 * makes positional matching unreliable (the frozen banner's Unfreeze button
 * sits after the dialog in DOM order but *behind* its overlay). Scope by the
 * dialog's own heading text instead.
 */
function dialogTitled(title: string) {
  return page.locator("body > div").filter({
    has: page.getByRole("heading", { name: title }),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  collector = ConsoleCollector.attach(page);
});

test.afterAll(async () => {
  await page.close();
});

/** Asserts a clean console and reports every offending message verbatim. */
function expectCleanConsole(flow: string) {
  expect(collector.violations(), collector.report(flow)).toEqual([]);
}

test("a. dashboard root route loads", async () => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "New Workspace" }).first()).toBeVisible();
  expectCleanConsole("a. root route");
});

test("b. create a workspace, welcome modal appears, close it", async () => {
  await page.getByRole("button", { name: "New Workspace" }).first().click();
  await page.getByPlaceholder("My Workspace").fill(workspaceName);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.waitForURL(`**/${workspaceSlug}`);
  const explore = page.getByRole("button", { name: "I'll explore on my own" });
  await expect(explore).toBeVisible();
  await explore.click();
  await expect(explore).toBeHidden();

  expectCleanConsole("b. create workspace + welcome modal");
});

test("c. create a board and open the board view", async () => {
  await page.goto(`/${workspaceSlug}/boards`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Create Board" }).first().click();
  await page.getByPlaceholder("Board name").fill(boardName);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  // CreateBoardDialog navigates straight into the board's kanban view.
  await page.waitForURL("**/kanban");
  await expect(page.getByRole("button", { name: "Board Settings" })).toBeVisible();

  expectCleanConsole("c. create board + board view");
});

test("d. freeze then unfreeze the board", async () => {
  // Freeze and unfreeze both live in the board settings dialog (operator
  // levers, not header actions); each closes the dialog on success.
  await page.getByRole("button", { name: "Board Settings" }).click();
  const freeze = page.getByRole("button", { name: "Freeze board" });
  await expect(freeze).toBeVisible();
  await freeze.click();
  await expect(page.getByText("This board is frozen", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Board Settings" }).click();
  // Two unfreeze buttons exist while frozen — the settings dialog's and the
  // frozen banner's (the latter is behind the overlay and unclickable).
  const unfreeze = dialogTitled("Board Settings").getByRole("button", {
    name: "Unfreeze",
  });
  await expect(unfreeze).toBeVisible();
  await unfreeze.click();
  await expect(page.getByText("This board is frozen", { exact: true })).toBeHidden();

  expectCleanConsole("d. freeze + unfreeze board");
});

test("e. delete the board and navigate away", async () => {
  await page.getByRole("button", { name: "Board Settings" }).click();
  await page.getByRole("button", { name: "Delete Board" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();

  await page.waitForURL(`**/${workspaceSlug}/boards`);
  await expect(page.getByRole("button", { name: "Create Board" }).first()).toBeVisible();

  expectCleanConsole("e. delete board");
});

test("f. delete the workspace and navigate away", async () => {
  await page.goto(`/${workspaceSlug}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Delete workspace" }).first().click();
  await page.locator("#workspace-delete-slug").fill(workspaceSlug);
  // The dialog's confirm shares the danger-zone trigger's exact label.
  await dialogTitled("Delete workspace?")
    .getByRole("button", { name: "Delete workspace" })
    .click();

  await page.waitForURL(new RegExp(`${page.url().split("/").slice(0, 3).join("/")}/?$`));
  await expect(page.getByRole("button", { name: "New Workspace" }).first()).toBeVisible();

  expectCleanConsole("f. delete workspace");
});

test("console stayed clean across the whole run", () => {
  expectCleanConsole("full run");
});
