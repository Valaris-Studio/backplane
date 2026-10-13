// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { ContentMarkdown } from "../ContentMarkdown";

// Captured content is untrusted evidence: it may format text, never fetch,
// run or embed anything.
describe("ContentMarkdown", () => {
  it("preserves single line breaks in captured prose without changing lists or code blocks", () => {
    const { container } = renderWithProviders(
      <ContentMarkdown text={"First observation\nSecond observation\n\n- one\n- two\n\n```text\nleft\nright\n```"} />,
    );

    const prose = screen.getByText(/First observation/);
    expect(prose.querySelector("br")).not.toBeNull();
    expect(prose.textContent).toContain("Second observation");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("pre code")).toHaveTextContent("left right");
    expect(container.querySelector("pre code")?.textContent).toBe("left\nright\n");
    expect(container.querySelector("pre br")).toBeNull();
  });

  it("formats text and keeps only http, https and mailto links, opened apart from the app", () => {
    const { container } = renderWithProviders(
      <ContentMarkdown
        text={"# Title\n\n- [site](https://example.com) [mail](mailto:a@example.com) [plain](http://example.com)\n- [js](javascript:alert(1)) [data](data:text/html,hi) [rel](../admin) [file](file:///etc/passwd)"}
      />,
    );

    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    for (const name of ["site", "mail", "plain"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
      expect(link).toHaveAttribute("target", "_blank");
    }
    for (const name of ["js", "data", "rel", "file"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(container.innerHTML).not.toMatch(/javascript:|data:text|file:/);
  });

  it("turns images into links to their address and never emits an <img>", () => {
    const { container } = renderWithProviders(
      <ContentMarkdown text={"![pixel](https://tracker.example/p.png) ![local](./shot.png) <img src=https://x.example/a.png>"} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "pixel" })).toHaveAttribute("href", "https://tracker.example/p.png");
    expect(screen.queryByRole("link", { name: "local" })).toBeNull();
  });

  it("shows raw HTML as text instead of rendering it", () => {
    const { container } = renderWithProviders(<ContentMarkdown text={"<script>alert(1)</script><iframe src=https://x.example></iframe><b onclick=x>bold</b>"} />);

    expect(container.querySelector("script, iframe, b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
