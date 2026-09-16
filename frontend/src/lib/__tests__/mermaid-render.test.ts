// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins the mermaid render seam: the security boundary (%%{init stripping,
// securityLevel:"strict"), the lazy import, and the id sanitation.
//
// mermaid is mocked at the module boundary — jsdom has no getBBox/getComputedTextLength,
// so a real mermaid render can never run here. That also proves the import is
// dynamic: a static top-level import in the module under test would be hoisted
// past vi.mock and blow up on the real ESM entry.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async (_id: string, _source: string) => ({ svg: "<svg id='ok'></svg>" })),
  initializeMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

import pkg from "../../../package.json";
import { renderMermaid, sanitizeRenderId, stripInitDirectives } from "../mermaid-render";

beforeEach(() => {
  renderMock.mockClear();
  initializeMock.mockClear();
  renderMock.mockResolvedValue({ svg: "<svg id='ok'></svg>" });
});

describe("mermaid version pin", () => {
  // CVE-2026-41149 (HTML injection via classDef) and CVE-2026-41148 (CSS
  // injection) are fixed in 11.15.0. securityLevel:"strict" alone does not
  // cover them — the version floor is part of the security posture, so it is
  // asserted here rather than left to review to notice.
  const pinned: string = pkg.dependencies.mermaid;

  it("is an EXACT pin, not a range that could resolve below the fix", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is at or above 11.15.0", () => {
    const [major = 0, minor = 0] = pinned.split(".").map(Number);
    expect(major > 11 || (major === 11 && minor >= 15)).toBe(true);
  });
});

describe("stripInitDirectives — THE security boundary", () => {
  it("removes a leading %%{init}%% directive that would raise securityLevel", () => {
    const source = '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A --> B';
    expect(stripInitDirectives(source)).toBe("flowchart TD\n  A --> B");
  });

  it("removes a directive that would override the theme", () => {
    const source = '%%{init: {"theme":"forest"}}%%\nflowchart TD\n  A --> B';
    expect(stripInitDirectives(source)).not.toContain("forest");
  });

  it("removes a directive on a later line, not just the first", () => {
    const source = 'flowchart TD\n%%{init: {"securityLevel":"loose"}}%%\n  A --> B';
    const stripped = stripInitDirectives(source);
    expect(stripped).not.toContain("securityLevel");
    expect(stripped).not.toContain("%%{init");
  });

  it("tolerates whitespace inside the directive head", () => {
    const source = '%%{  init  : {"securityLevel":"loose"}}%%\nflowchart TD';
    expect(stripInitDirectives(source)).not.toContain("securityLevel");
  });

  it("leaves ordinary diagram source untouched", () => {
    const source = "flowchart TD\n  A[Start] --> B[End]";
    expect(stripInitDirectives(source)).toBe(source);
  });

  it("does not eat a non-init %% comment", () => {
    const source = "%% just a comment\nflowchart TD\n  A --> B";
    expect(stripInitDirectives(source)).toContain("just a comment");
  });
});

describe("sanitizeRenderId", () => {
  // React 19's useId() emits «r0» / :r0: — mermaid does select('#' + id),
  // so an unsanitized id is an invalid CSS selector and the render throws.
  it("strips the characters React 19 useId() puts in an id", () => {
    expect(sanitizeRenderId("«r0»")).toBe("mermaid-r0");
    expect(sanitizeRenderId(":r1:")).toBe("mermaid-r1");
  });

  it("always produces a selector-safe id starting with the mermaid- prefix", () => {
    const id = sanitizeRenderId("«r2c»");
    expect(id).toMatch(/^mermaid-[A-Za-z0-9_-]*$/);
  });
});

describe("renderMermaid", () => {
  it("initializes with securityLevel strict and startOnLoad false", async () => {
    await renderMermaid({ id: "«r0»", source: "flowchart TD\n A-->B", theme: "light" });
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
    );
  });

  it("maps the resolved app theme onto mermaid's theme", async () => {
    await renderMermaid({ id: "«r0»", source: "flowchart TD", theme: "dark" });
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));

    initializeMock.mockClear();
    await renderMermaid({ id: "«r0»", source: "flowchart TD", theme: "light" });
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: "default" }));
  });

  it("passes the STRIPPED source to mermaid.render, never the raw directive", async () => {
    await renderMermaid({
      id: "«r0»",
      source: '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A --> B',
      theme: "light",
    });
    const passedSource = renderMock.mock.calls[0]?.[1];
    expect(passedSource).toBe("flowchart TD\n  A --> B");
    expect(passedSource).not.toContain("securityLevel");
  });

  it("renders under a sanitized id", async () => {
    await renderMermaid({ id: "«r7»", source: "flowchart TD", theme: "light" });
    expect(renderMock.mock.calls[0]?.[0]).toBe("mermaid-r7");
  });

  it("returns the svg mermaid produced", async () => {
    renderMock.mockResolvedValue({ svg: "<svg id='drawn'></svg>" });
    const svg = await renderMermaid({ id: "a", source: "flowchart TD", theme: "light" });
    expect(svg).toBe("<svg id='drawn'></svg>");
  });

  it("propagates a syntax error so the caller can show it inline", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    await expect(
      renderMermaid({ id: "a", source: "not a diagram", theme: "light" }),
    ).rejects.toThrow("Parse error on line 2");
  });
});
