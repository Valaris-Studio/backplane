// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(__dirname, "../..");

/**
 * THE RULE: a consumer whose WS handler does nothing but invalidate React
 * Query keys must use `useDomainSync`, not the raw `useWebSocketEvent`
 * primitive. `useDomainSync` debounces the invalidation, so a burst of bus
 * events collapses into one refetch instead of stampeding the API.
 *
 * Raw `useWebSocketEvent` stays legitimate for exactly two shapes:
 *   1. the primitives themselves (`use-websocket.ts` defines it,
 *      `useDomainSync.ts` wraps it), and
 *   2. consumers that READ THE PAYLOAD — they need the event object, not just
 *      a refetch signal, so debounced invalidation is not the right semantic.
 *
 * Adding a file here is a deliberate act: justify it in the review, or migrate
 * to `useDomainSync` instead.
 */
// use-websocket.ts DEFINES the primitive rather than importing it, so it is
// exempt from the import scan by construction; useDomainSync.ts is the one
// file allowed to import it in order to wrap it.
const PRIMITIVE_DEFINITION = "hooks/use-websocket.ts";

const RAW_PRIMITIVE_ALLOWLIST = new Set([
  PRIMITIVE_DEFINITION,
  "hooks/useDomainSync.ts",
]);

const PAYLOAD_READING_ALLOWLIST = new Set([
  "features/alerts/hooks/useCostAlerts.ts",
  "features/notifications/api/use-notifications.ts",
  "features/observer/hooks/useObserverEvents.ts",
  "features/workspaces/components/CostAlertBanner.tsx",
]);

const ALLOWED = new Set([
  ...RAW_PRIMITIVE_ALLOWLIST,
  ...PAYLOAD_READING_ALLOWLIST,
]);

function productionSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    files.push(absolute);
  }
  return files;
}

function importsRawPrimitive(source: string): boolean {
  // Only an actual import binds the primitive; the identifier also appears in
  // prose comments explaining the rule (including this file's own docs).
  return /^\s*import\s+\{[^}]*\buseWebSocketEvent\b[^}]*\}\s+from\s+/m.test(
    source,
  );
}

describe("useDomainSync is the only route to invalidation-only WS sync", () => {
  it("no production file outside the allowlist imports useWebSocketEvent", () => {
    const offenders = productionSourceFiles(SRC_ROOT)
      .filter((file) => importsRawPrimitive(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_ROOT, file))
      .filter((relative) => !ALLOWED.has(relative))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("no allowlist entry has gone stale", () => {
    // An entry earns its place only while the file exists AND still reaches
    // for the raw primitive. Once a consumer migrates to useDomainSync, its
    // exemption must come out — otherwise the allowlist quietly grows into a
    // list of files nobody re-examines.
    const stale = [...ALLOWED].filter((relative) => {
      let source: string;
      try {
        source = readFileSync(path.join(SRC_ROOT, relative), "utf8");
      } catch {
        return true;
      }
      if (relative === PRIMITIVE_DEFINITION) {
        return !/export function useWebSocketEvent\b/.test(source);
      }
      return !importsRawPrimitive(source);
    });

    expect(stale).toEqual([]);
  });
});
