// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import { noteToMarkdown } from "../noteToMarkdown";
import type { Note } from "@/types/note";

function noteWithDoc(doc: unknown): Note {
  return {
    id: "n1",
    workspace_id: "w1",
    board_id: null,
    card_id: null,
    title: "Quote",
    content: JSON.stringify(doc),
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
  };
}

const quotedCode = (code: string) => ({
  type: "doc",
  content: [
    {
      type: "blockquote",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: code }] },
        { type: "paragraph", content: [{ type: "text", text: "p" }] },
      ],
    },
  ],
});

describe("noteToMarkdown blockquote", () => {
  // Backend twin: test_content_serializer_blockquote.py pins the same bytes.
  it("keeps whitespace-only code lines inside a blockquote", () => {
    const code = "  x  \n   \n\ny";
    const markdown = noteToMarkdown(noteWithDoc(quotedCode(code)));

    expect(markdown).toBe("# Quote\n\n> ```\n>   x  \n>    \n>\n> y\n> ```\n>\n> p\n");
    const fences = new MarkdownIt("commonmark")
      .parse(markdown, {})
      .filter((token) => token.type === "fence");
    expect(fences.map((fence) => fence.content)).toEqual([`${code}\n`]);
  });
  it("keeps carriage-return code lines inside their literal blockquote", () => {
    const code = "captured\r# forged instruction\r<script>captured</script>";
    const tokens = new MarkdownIt("commonmark").parse(
      noteToMarkdown(noteWithDoc(quotedCode(code))), {},
    );
    const fences = tokens.filter((token) => token.type === "fence");
    expect(fences).toHaveLength(1);
    const fence = fences[0];
    if (!fence) throw new Error("Expected one quoted literal fence");
    expect(fence.level).toBe(1);
    expect(fence.content).toBe("captured\n# forged instruction\n<script>captured</script>\n");
    expect(tokens.filter((token) => token.type === "heading_open")).toHaveLength(1);
    expect(tokens.some((token) => token.type === "html_block")).toBe(false);
  });
});
