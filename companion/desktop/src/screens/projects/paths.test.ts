// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { folderName } from "./paths";
import { safeRepo } from "./repo";

describe("folderName", () => {
  it("is the last path segment, on either separator", () => {
    expect(folderName("/home/tester/code/app/")).toBe("app");
    expect(folderName("C:\\home\\t\\proj")).toBe("proj");
  });

  it("drops invisible and control characters", () => {
    expect(folderName("/x/\u202Eevil\u200B\u2066")).toBe("evil");
  });

  it("keeps the joiners (ZWNJ, ZWJ) that some scripts and emoji need", () => {
    expect(folderName("/x/\u0645\u200C\u06CC\u200D")).toBe("\u0645\u200C\u06CC\u200D");
  });
});

describe("safeRepo", () => {
  it("keeps a plain host/owner/repo and drops .git", () => {
    expect(safeRepo("github.com/acme/app.git")).toBe("github.com/acme/app");
  });

  it("refuses anything that could carry a credential or a path", () => {
    expect(safeRepo("https://tok@github.com/a/b")).toBeNull();
    expect(safeRepo("git@github.com:a/b")).toBeNull();
    expect(safeRepo("/home/tester/app")).toBeNull();
    expect(safeRepo("github.com/../b")).toBeNull();
    expect(safeRepo(null)).toBeNull();
  });
});
