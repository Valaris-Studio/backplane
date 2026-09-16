// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import { ConsoleCollector } from "./console-collector";

/**
 * Positive control for the console-clean gate. A detector that can only report
 * "clean" is indistinguishable from one that is broken, so this test proves the
 * collector still has red-capability: it injects a console error the allowlist
 * must NOT swallow and asserts the collector flagged it as a violation.
 *
 * This test passing means the gate can fail. If it ever goes green while the
 * collector is dead, that is a contradiction — hence the explicit assertions on
 * both the captured text and the violation count.
 */
test("detector fires on an injected console error", async ({ page }) => {
  const collector = ConsoleCollector.attach(page);
  await page.goto("/", { waitUntil: "networkidle" });

  const marker = "gate-selftest: intentional";
  await page.evaluate((text) => console.error(text), marker);
  await expect
    .poll(() => collector.all().some((m) => m.text.includes(marker)))
    .toBe(true);

  const violations = collector.violations();
  expect(
    violations.map((m) => m.text),
    "the injected error must be reported as a NON-allowlisted violation",
  ).toContain(marker);
  expect(
    violations.filter((m) => m.text.includes(marker)),
    "the allowlist must not swallow an arbitrary console.error",
  ).toHaveLength(1);

  // The failure report must name the offender, since that text is the only
  // diagnostic an operator sees when the real gate goes red.
  expect(collector.report("selftest")).toContain(marker);
});

test("pageerror (uncaught exception) is captured too", async ({ page }) => {
  const collector = ConsoleCollector.attach(page);
  await page.goto("/", { waitUntil: "networkidle" });

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("gate-selftest: uncaught");
    }, 0);
  });

  await expect
    .poll(() => collector.violations().some((m) => m.source === "pageerror"))
    .toBe(true);
  expect(collector.violations().map((m) => m.text).join("\n")).toContain(
    "gate-selftest: uncaught",
  );
});
