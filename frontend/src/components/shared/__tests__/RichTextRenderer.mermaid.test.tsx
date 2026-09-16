// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P1-3 (mermaid) in the RENDERER extension list. RichTextRenderer
// is the read-only surface (card descriptions, note bodies) and has its OWN
// extension array — registering the NodeView only in the editor would leave
// every read-only view showing raw `flowchart TD` text. There is no mechanical
// diff between the two lists, so this per-surface test is the guard.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { RichTextRenderer } from "../RichTextRenderer";

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async () => ({ svg: "<svg data-testid='diagram'></svg>" })),
  initializeMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

beforeAll(() => {
  const rect = {
    top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

beforeEach(() => {
  renderMock.mockClear();
  initializeMock.mockClear();
  renderMock.mockResolvedValue({ svg: "<svg data-testid='diagram'></svg>" });
});

const MERMAID_DOC = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "flowchart TD\n  A --> B" }],
    },
  ],
});

describe("RichTextRenderer — mermaid renders read-only", () => {
  it("renders the diagram SVG in the read-only surface", async () => {
    renderWithProviders(<RichTextRenderer content={MERMAID_DOC} />);

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull(),
    );
  });

  it("offers NO edit affordance when the editor is not editable", async () => {
    renderWithProviders(<RichTextRenderer content={MERMAID_DOC} />);

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /edit diagram/i })).toBeNull();
  });

  it("still applies securityLevel strict on the read-only path", async () => {
    renderWithProviders(<RichTextRenderer content={MERMAID_DOC} />);

    await waitFor(() => expect(initializeMock).toHaveBeenCalled());
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
  });

  it("keeps a non-mermaid code block as plain pre/code", async () => {
    const tsDoc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    const { container } = renderWithProviders(<RichTextRenderer content={tsDoc} />);

    await waitFor(() => expect(container.querySelector("pre code")).not.toBeNull());
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
    // The mermaid branch ALSO renders a <pre><code> (the hidden source node),
    // so "a pre code exists" cannot tell the branches apart. These two are the
    // real discriminators: no diagram chrome, and mermaid never invoked.
    expect(container.querySelector("[data-mermaid-preview]")).toBeNull();
    expect(container.querySelector("[data-mermaid-block]")).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });
});
