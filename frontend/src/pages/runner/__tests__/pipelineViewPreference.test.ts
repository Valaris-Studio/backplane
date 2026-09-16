// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  ADVANCED_VIEW_STORAGE_KEY,
  readAdvancedView,
  writeAdvancedView,
} from "../pipelineViewPreference";

afterEach(() => {
  window.localStorage.removeItem(ADVANCED_VIEW_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("pipelineViewPreference", () => {
  it("defaults to the tree when nothing is stored", () => {
    expect(readAdvancedView()).toBe("tree");
  });

  it("round-trips a stored choice", () => {
    writeAdvancedView("form");
    expect(readAdvancedView()).toBe("form");
    writeAdvancedView("tree");
    expect(readAdvancedView()).toBe("tree");
  });

  it("rejects a value that is not an advanced view", () => {
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, "graph");
    expect(readAdvancedView()).toBe("tree");
  });

  it("degrades to the default when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked in privacy mode");
    });
    expect(readAdvancedView()).toBe("tree");
  });

  it("swallows a write that throws rather than breaking the toggle", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeAdvancedView("form")).not.toThrow();
  });
});
