// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPANION_RELEASE } from "../companion-release";

const companionReadme = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../companion/README.md"),
  "utf8",
);

describe("Companion release pin", () => {
  it("offers the same macOS download the Companion README publishes", () => {
    expect(companionReadme).toContain(COMPANION_RELEASE.macDownloadUrl);
    expect(COMPANION_RELEASE.macDownloadUrl).toContain(`/v${COMPANION_RELEASE.version}/`);
  });

  it("points Linux and Windows people at the public source", () => {
    expect(COMPANION_RELEASE.sourceUrl).toBe("https://github.com/Valaris-Studio/backplane/tree/main/companion");
  });
});
