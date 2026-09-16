// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The tiptap pins live in TWO pnpm-workspace.yaml files: the repo root one
// (applies to dev installs from the monorepo) and frontend/ (applies to
// standalone installs — the Docker image and CI build frontend/ without the
// repo root in context). pnpm hard-fails a --frozen-lockfile install when the
// effective overrides don't match the lockfile, so a divergence between the
// two files breaks either CI or the Docker build depending on which lockfile
// was regenerated last. This guard keeps them byte-equivalent.

function parseOverrides(yamlPath: string): Record<string, string> {
  const lines = readFileSync(yamlPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line === "overrides:");
  expect(start, `no overrides block in ${yamlPath}`).toBeGreaterThanOrEqual(0);
  const overrides: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = line.match(/^ {2}['"]?([^'":]+)['"]?:\s*(.+)$/);
    if (!match) break; // dedented — end of the overrides block
    overrides[match[1]!] = match[2]!.trim();
  }
  return overrides;
}

describe("pnpm overrides sync", () => {
  it("frontend/pnpm-workspace.yaml mirrors the repo-root overrides", () => {
    const rootOverrides = parseOverrides(resolve(__dirname, "../../../../pnpm-workspace.yaml"));
    const frontendOverrides = parseOverrides(resolve(__dirname, "../../../pnpm-workspace.yaml"));
    expect(frontendOverrides).toEqual(rootOverrides);
    expect(Object.keys(rootOverrides).length).toBeGreaterThan(0);
  });
});
