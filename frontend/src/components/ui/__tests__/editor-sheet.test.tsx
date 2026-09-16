// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorSheet } from "../editor-sheet";

function renderSheet(extra?: Partial<Parameters<typeof EditorSheet>[0]>) {
  return render(
    <EditorSheet
      open
      onOpenChange={() => {}}
      title="Edit thing"
      description="subtitle"
      headerActions={<button>HeaderSave</button>}
      footer={<button>FooterSave</button>}
      {...extra}
    >
      <p>body content</p>
    </EditorSheet>,
  );
}

describe("EditorSheet — pinned header/footer, scrolling body", () => {
  it("renders title, description, header actions, body, and footer", () => {
    renderSheet();
    expect(screen.getByText("Edit thing")).toBeInTheDocument();
    expect(screen.getByText("subtitle")).toBeInTheDocument();
    expect(screen.getByText("HeaderSave")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
    expect(screen.getByText("FooterSave")).toBeInTheDocument();
  });

  it("scrolls the body internally while pinning the footer (footer is NOT in the scroll body)", () => {
    renderSheet();
    const body = screen.getByText("body content").closest("div");
    const footer = screen.getByText("FooterSave").closest("div");
    // The body owns the scroll; the footer is a sibling, never nested inside the
    // scrolling region — that's what keeps the actions visible without scrolling.
    expect(body?.className).toContain("overflow-y-auto");
    expect(body?.className).toContain("flex-1");
    expect(footer?.className).toContain("shrink-0");
    expect(body?.contains(footer ?? null)).toBe(false);
  });

  it("omits the footer region entirely when no footer is given", () => {
    renderSheet({ footer: undefined });
    expect(screen.queryByText("FooterSave")).not.toBeInTheDocument();
  });

  it("collapses the visible header when no title/description/actions are given, keeping only an sr-only name", () => {
    render(
      <EditorSheet
        open
        onOpenChange={() => {}}
        a11yTitle="Edit thing"
        footer={<button>FooterSave</button>}
      >
        <p>body content</p>
      </EditorSheet>,
    );
    // The accessible name is preserved for screen readers. Match by text +
    // selector, not getByRole({name}): the GSAP enter animation leaves the
    // sheet visibility:hidden, which zeroes the computed accessible name.
    const heading = screen.getByText("Edit thing", { selector: "h2" });
    expect(heading.className).toContain("sr-only");
    // …but there is no visible header band (the sr-only title is the only
    // heading, and the scroll body clears just the compact close X via pt-11).
    const body = screen.getByText("body content").closest("div");
    expect(body?.className).toContain("pt-11");
  });

  it("portals to document.body (inherits Sheet's portal — escapes transformed ancestors)", () => {
    render(
      <div data-testid="ancestor" style={{ transform: "translateY(10px)" }}>
        <EditorSheet open onOpenChange={() => {}} title="T" footer={<span>F</span>}>
          <p>portaled body</p>
        </EditorSheet>
      </div>,
    );
    const content = screen.getByText("portaled body");
    expect(document.body.contains(content)).toBe(true);
    expect(screen.getByTestId("ancestor").contains(content)).toBe(false);
  });
});
