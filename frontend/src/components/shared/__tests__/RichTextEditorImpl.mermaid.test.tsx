// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P1-3 (mermaid) in the EDITOR surface: a codeBlock whose
// attrs.language is "mermaid" renders a diagram preview, every other language
// keeps rendering as a plain <pre><code>, and the toolbar can insert one.
//
// mermaid is mocked at the module boundary — jsdom implements none of the SVG
// measurement APIs (getBBox, getComputedTextLength) a real mermaid render
// needs, so the picture itself is NOT provable here. What IS provable, and is
// what these tests pin, is the wiring: which source reaches mermaid, under
// which security options, and what the DOM shows in each branch.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import RichTextEditorImpl from "../RichTextEditorImpl";

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(
    async (_id: string, _source: string) => ({ svg: "<svg data-testid='diagram'></svg>" }),
  ),
  initializeMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

// prosemirror-view probes DOM geometry APIs jsdom doesn't implement.
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

function docWith(language: string, text: string) {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "codeBlock", attrs: { language }, content: [{ type: "text", text }] }],
  });
}

const MERMAID_SOURCE = "flowchart TD\n  A[Start] --> B[End]";

describe("RichTextEditorImpl — mermaid code blocks render as diagrams", () => {
  it("renders the mermaid SVG for a codeBlock with language mermaid", async () => {
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", MERMAID_SOURCE)} onChange={() => {}} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull(),
    );
  });

  it("passes the diagram source to mermaid.render", async () => {
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", MERMAID_SOURCE)} onChange={() => {}} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(renderMock.mock.calls[0]?.[1]).toBe(MERMAID_SOURCE);
  });

  it("renders with securityLevel strict — never loose", async () => {
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", MERMAID_SOURCE)} onChange={() => {}} />,
    );

    await waitFor(() => expect(initializeMock).toHaveBeenCalled());
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
  });

  it("strips a stored %%{init}%% directive before rendering", async () => {
    const hostile = '%%{init: {"securityLevel":"loose"}}%%\n' + MERMAID_SOURCE;
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", hostile)} onChange={() => {}} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    const passed = renderMock.mock.calls[0]?.[1];
    expect(passed).not.toContain("securityLevel");
    expect(passed).toBe(MERMAID_SOURCE);
  });

  it("keeps a NON-mermaid code block as a plain pre/code and never calls mermaid", async () => {
    const { container } = renderWithProviders(
      <RichTextEditorImpl content={docWith("ts", "const x = 1;")} onChange={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector("pre code")).not.toBeNull());
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
    expect(container.querySelector("[data-mermaid-preview]")).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("shows the error inline and KEEPS the source when the diagram does not parse", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const onChange = vi.fn();
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", "not a diagram")} onChange={onChange} />,
    );

    expect(await screen.findByText(/Diagram error/i)).toBeInTheDocument();
    // The raw source must survive a failed render — a diagram that cannot be
    // drawn must never cost the user their text.
    await waitFor(() =>
      expect(document.querySelector("[data-mermaid-source]")?.textContent).toContain(
        "not a diagram",
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inserts a mermaid code block from the toolbar", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<RichTextEditorImpl content="" onChange={onChange} />);

    await user.click(await screen.findByRole("button", { name: /diagram/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const emitted = onChange.mock.calls.at(-1)?.[0] as string;
    const doc = JSON.parse(emitted);
    const blocks = doc.content.filter(
      (n: { type: string; attrs?: { language?: string } }) =>
        n.type === "codeBlock" && n.attrs?.language === "mermaid",
    );
    expect(blocks).toHaveLength(1);
  });

  it("keeps the diagram text in the document so it persists as a mermaid fence", async () => {
    renderWithProviders(
      <RichTextEditorImpl content={docWith("mermaid", MERMAID_SOURCE)} onChange={() => {}} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    // NodeViewContent stays mounted even while the preview is showing, so
    // ProseMirror never loses the node's text.
    expect(document.querySelector("[data-mermaid-source]")?.textContent).toContain("flowchart TD");
  });
});
