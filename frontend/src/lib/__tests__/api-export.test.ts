// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchExportBlob,
  parseFilenameFromContentDisposition,
} from "../api-export";
import { api } from "../api";

describe("parseFilenameFromContentDisposition", () => {
  it("extracts a quoted filename", () => {
    expect(
      parseFilenameFromContentDisposition(
        'attachment; filename="acme.valaris.pipeline.json"',
      ),
    ).toBe("acme.valaris.pipeline.json");
  });

  it("extracts an unquoted filename", () => {
    expect(
      parseFilenameFromContentDisposition("attachment; filename=plain.json"),
    ).toBe("plain.json");
  });

  it("prefers RFC 5987 filename* when both are present", () => {
    expect(
      parseFilenameFromContentDisposition(
        "attachment; filename=\"fallback.json\"; filename*=UTF-8''pretty%20name.json",
      ),
    ).toBe("pretty name.json");
  });

  it("returns null on missing or malformed headers", () => {
    expect(parseFilenameFromContentDisposition(null)).toBeNull();
    expect(parseFilenameFromContentDisposition(undefined)).toBeNull();
    expect(parseFilenameFromContentDisposition("attachment")).toBeNull();
  });
});

describe("fetchExportBlob", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the blob plus parsed filename from the response", async () => {
    const blob = new Blob(["{}"], { type: "application/json" });
    vi.spyOn(api, "get").mockResolvedValueOnce({
      data: blob,
      headers: {
        "content-disposition": 'attachment; filename="exported.json"',
      },
    } as never);

    const result = await fetchExportBlob("/foo/export", "fallback.json");
    expect(result.blob).toBe(blob);
    expect(result.filename).toBe("exported.json");
  });

  it("falls back when no Content-Disposition is present", async () => {
    const blob = new Blob(["{}"]);
    vi.spyOn(api, "get").mockResolvedValueOnce({
      data: blob,
      headers: {},
    } as never);

    const result = await fetchExportBlob("/foo/export", "fallback.json");
    expect(result.filename).toBe("fallback.json");
  });

  it("requests the path with responseType=blob", async () => {
    const spy = vi.spyOn(api, "get").mockResolvedValueOnce({
      data: new Blob([]),
      headers: {},
    } as never);

    await fetchExportBlob("/path/to/export", "fb.json");
    expect(spy).toHaveBeenCalledWith("/path/to/export", { responseType: "blob" });
  });
});
