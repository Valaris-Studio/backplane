// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P0-1 (tables) in the EDITOR extension list: RichTextEditorImpl's
// useEditor has no table nodes, so opening a note/card whose content is a PM
// table doc drops the table instead of showing an editable <table>.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

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

const CANONICAL_TABLE_DOC = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
          ],
        },
      ],
    },
  ],
};

describe("RichTextEditor — table PM JSON stays an editable <table>", () => {
  it("mounts an editable editor whose doc keeps the table's four cells separate", async () => {
    const { container } = renderWithProviders(
      <RichTextEditor
        content={JSON.stringify(CANONICAL_TABLE_DOC)}
        onChange={vi.fn()}
        editable
      />,
    );

    // immediatelyRender: false — the editor mounts in an effect.
    await waitFor(() => {
      expect(container.querySelector(".tiptap-editor")).not.toBeNull();
    });

    const table = await waitFor(() => {
      const el = container.querySelector("table");
      expect(el, "editor doc should contain a <table> element").not.toBeNull();
      return el as HTMLTableElement;
    });

    const headers = [...table.querySelectorAll("th")];
    const cells = [...table.querySelectorAll("td")];
    expect(headers).toHaveLength(2);
    expect(cells).toHaveLength(2);
    expect(headers.map((el) => el.textContent)).toEqual(["A", "B"]);
    expect(cells.map((el) => el.textContent)).toEqual(["1", "2"]);
  });
});
