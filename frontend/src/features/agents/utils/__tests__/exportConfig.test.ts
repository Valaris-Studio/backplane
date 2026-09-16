// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadAgentConfigBundle } from "../exportConfig";
import { api } from "@/lib/api";

// The export-config endpoint returns a ZIP bundle (runner-{name}.yaml +
// mcp-config-{name}.json). The download filename must reflect that it is a zip,
// not a bare .yaml — saving zip bytes under a .yaml name produced an unopenable
// file (the bug this test locks down).
describe("downloadAgentConfigBundle", () => {
  let anchor: HTMLAnchorElement;

  beforeEach(() => {
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = vi.fn(() => "blob:x");
      window.URL.revokeObjectURL = vi.fn();
    }
    anchor = document.createElement("a");
    vi.spyOn(anchor, "click").mockImplementation(() => {});
    vi.spyOn(document, "createElement").mockReturnValue(anchor);
    vi.spyOn(api, "get").mockResolvedValue({ data: new Blob(["zip-bytes"]) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves the bundle under a .zip filename (not .yaml)", async () => {
    await downloadAgentConfigBundle("ag-1", "frogger");
    expect(anchor.download).toBe("runner-frogger.zip");
  });
});
