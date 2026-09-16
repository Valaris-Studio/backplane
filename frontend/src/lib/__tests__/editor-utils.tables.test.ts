// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P0-1 (tables): the shared EXTENSIONS list has no table node, so
// GFM tables coming through markdown-it are flattened into concatenated cell
// text ("AB12"), table-only markdown misses MARKDOWN_HINT_RE (no pipe branch)
// and renders literal pipes, and .tiptap-editor has zero table CSS.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseContent } from "../editor-utils";

type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string };

function asDoc(value: object): PMNode {
  const doc = value as PMNode;
  expect(doc.type).toBe("doc");
  return doc;
}

function present<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`expected ${label} to be defined`);
  return v;
}

function child(node: PMNode, i: number): PMNode {
  const arr = present(node.content, "content");
  return present(arr[i], `content[${i}]`);
}

// cell → paragraph → text
function cellText(cell: PMNode): string | undefined {
  return child(child(cell, 0), 0).text;
}

// Canonical table doc generated with the real tiptap 3.20.2 table schema.
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

const GFM_TABLE = "| A | B |\n| --- | --- |\n| 1 | 2 |";

describe("parseContent — table support (editor P0-1)", () => {
  it("parses markdown containing a GFM table into a table node, not concatenated cell text", () => {
    const doc = asDoc(parseContent(`# Title\n\n${GFM_TABLE}`));

    const heading = child(doc, 0);
    expect(heading.type).toBe("heading");
    expect(heading.attrs?.level).toBe(1);

    const table = child(doc, 1);
    expect(table.type).toBe("table");
    const rows = present(table.content, "table rows");
    expect(rows).toHaveLength(2);

    const headerRow = present(rows[0], "rows[0]");
    expect(headerRow.type).toBe("tableRow");
    const headerCells = present(headerRow.content, "header cells");
    expect(headerCells.map((c) => c.type)).toEqual(["tableHeader", "tableHeader"]);
    expect(headerCells.map((c) => cellText(c))).toEqual(["A", "B"]);

    const bodyRow = present(rows[1], "rows[1]");
    const bodyCells = present(bodyRow.content, "body cells");
    expect(bodyCells.map((c) => c.type)).toEqual(["tableCell", "tableCell"]);
    expect(bodyCells.map((c) => cellText(c))).toEqual(["1", "2"]);

    // The exact pre-fix mangling: cell texts fused with no separators.
    const flat = JSON.stringify(doc);
    expect(flat).not.toContain("AB12");
    expect(flat).toContain('"type":"table"');
  });

  it("recognizes table-ONLY markdown (no other markdown marker) via the pipe hint", () => {
    // Today MARKDOWN_HINT_RE has no pipe branch, so this falls through to the
    // plain-text branch and comes back as one paragraph of literal pipes.
    const doc = asDoc(parseContent(GFM_TABLE));
    expect(child(doc, 0).type).toBe("table");
  });

  it("converts HTML tables through generateJSON into a table node", () => {
    const doc = asDoc(
      parseContent(
        "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      ),
    );
    const table = child(doc, 0);
    expect(table.type).toBe("table");
    const rows = present(table.content, "table rows");
    expect(rows).toHaveLength(2);
    expect(present(present(rows[0], "rows[0]").content, "header cells").map((c) => cellText(c))).toEqual(["A", "B"]);
    expect(present(present(rows[1], "rows[1]").content, "body cells").map((c) => cellText(c))).toEqual(["1", "2"]);
  });

  it("passes through canonical table PM JSON unchanged", () => {
    expect(parseContent(JSON.stringify(CANONICAL_TABLE_DOC))).toEqual(CANONICAL_TABLE_DOC);
  });
});

describe("index.css — .tiptap-editor table styles exist (editor P0-1 CSS pin)", () => {
  it("styles table/th/td with horizontal overflow handling inside the .tiptap-editor block", () => {
    // import.meta.url is http-scheme under vitest's jsdom transform, so
    // resolve from the vitest root (frontend/) instead.
    const cssPath = path.resolve(process.cwd(), "src/index.css");
    const css = readFileSync(cssPath, "utf8");
    const blockStart = css.indexOf(".tiptap-editor {");
    expect(blockStart).toBeGreaterThan(-1);

    const tiptapBlock = css.slice(blockStart);
    expect(tiptapBlock).toMatch(/table\s*\{/);
    expect(tiptapBlock).toMatch(/\bth\b\s*[,{]/);
    expect(tiptapBlock).toMatch(/\btd\b\s*[,{]/);
    expect(tiptapBlock).toContain("overflow-x");
  });
});
