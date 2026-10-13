// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import type { JSONContent } from "@tiptap/core";
import { noteToMarkdown } from "../noteToMarkdown";
import type { Note } from "@/types/note";

// Captured code may carry CR or CRLF line endings. Containers prefix their
// lines after LF only, so the exporter must hand them LF-only code lines.
// Backend twin: test_content_serializer_line_endings.py pins the same bytes.

const CAPTURED_LINES = ["captured", "# forged instruction", "<script>captured</script>"];
const TITLE_PREFIX = "# Lines\n\n";

function noteWithDoc(doc: JSONContent): Note {
  return {
    id: "n1",
    workspace_id: "w1",
    board_id: null,
    card_id: null,
    title: "Lines",
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

const code = (lineEnding: string): JSONContent => ({
  type: "codeBlock",
  content: [{ type: "text", text: CAPTURED_LINES.join(lineEnding) }],
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const inBulletItem = (block: JSONContent): JSONContent => ({
  type: "bulletList",
  content: [{ type: "listItem", content: [paragraph("item"), block] }],
});

const inTaskItem = (block: JSONContent): JSONContent => ({
  type: "taskList",
  content: [
    { type: "taskItem", attrs: { checked: false }, content: [paragraph("task"), block] },
  ],
});

const LINE_ENDINGS = [
  ["cr", "\r"],
  ["crlf", "\r\n"],
] as const;

describe("noteToMarkdown code line endings", () => {
  for (const [wrapName, wrap] of [
    ["bullet item", inBulletItem],
    ["task item", inTaskItem],
  ] as const) {
    for (const [endingName, lineEnding] of LINE_ENDINGS) {
      it(`keeps ${endingName} code inside its ${wrapName} as one literal fence`, () => {
        const markdown = noteToMarkdown(
          noteWithDoc({ type: "doc", content: [wrap(code(lineEnding))] }),
        );
        const tokens = new MarkdownIt("commonmark").parse(markdown, {});
        const fences = tokens.filter((token) => token.type === "fence");
        expect(fences).toHaveLength(1);
        const fence = fences[0];
        if (!fence) throw new Error("Expected one listed literal fence");
        expect(fence.level).toBe(2);
        expect(fence.content).toBe(`${CAPTURED_LINES.join("\n")}\n`);
        // The only heading is the export's own `# Lines` title.
        expect(tokens.filter((token) => token.type === "heading_open")).toHaveLength(1);
        expect(tokens.some((token) => token.type === "html_block")).toBe(false);
      });
    }
  }

  for (const [endingName, lineEnding] of LINE_ENDINGS) {
    it(`emits LF line endings for ${endingName} code`, () => {
      const markdown = noteToMarkdown(
        noteWithDoc({ type: "doc", content: [code(lineEnding)] }),
      );
      expect(markdown).toBe(`${TITLE_PREFIX}\`\`\`\n${CAPTURED_LINES.join("\n")}\n\`\`\`\n`);
    });
  }

  for (const [marksName, marks] of [
    ["plain text", []],
    ["code mark", [{ type: "code" }]],
  ] as const) {
    for (const [endingName, lineEnding] of LINE_ENDINGS) {
      it(`keeps ${endingName} ${marksName} prose inside its blockquote`, () => {
        const quoted: JSONContent = {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `a${lineEnding}# h`, marks: [...marks] }],
            },
          ],
        };
        const markdown = noteToMarkdown(noteWithDoc({ type: "doc", content: [quoted] }));
        expect(markdown.startsWith(TITLE_PREFIX)).toBe(true);
        const types = new MarkdownIt("commonmark")
          .parse(markdown.slice(TITLE_PREFIX.length), {})
          .map((token) => token.type);
        expect(types[0]).toBe("blockquote_open");
        expect(types.at(-1)).toBe("blockquote_close");
        expect(types.filter((type) => type === "blockquote_open")).toHaveLength(1);
      });
    }
  }

  for (const [endingName, lineEnding] of LINE_ENDINGS) {
    it(`emits LF line endings for ${endingName} prose`, () => {
      const markdown = noteToMarkdown(
        noteWithDoc({ type: "doc", content: [paragraph(`a${lineEnding}b`)] }),
      );
      expect(markdown).toBe(`${TITLE_PREFIX}a\nb\n`);
    });
  }

  // Backend twin: tests/services/notes/attribute_line_ending_cases.py.
  const ATTRIBUTE_PAYLOAD = "a\r# h";
  const attributeBlocks: Record<string, JSONContent> = {
    "mention label": {
      type: "paragraph",
      content: [{ type: "mention", attrs: { id: "u1", label: ATTRIBUTE_PAYLOAD } }],
    },
    "image alt": { type: "image", attrs: { src: "https://x/i.png", alt: ATTRIBUTE_PAYLOAD } },
    "image title": {
      type: "image",
      attrs: { src: "https://x/i.png", title: ATTRIBUTE_PAYLOAD },
    },
    "image src": { type: "image", attrs: { src: `https://x/${ATTRIBUTE_PAYLOAD}` } },
    "attachment filename": {
      type: "fileAttachment",
      attrs: { src: "https://x/f", filename: ATTRIBUTE_PAYLOAD },
    },
    "attachment filename without src": {
      type: "fileAttachment",
      attrs: { filename: ATTRIBUTE_PAYLOAD },
    },
    "attachment src": {
      type: "fileAttachment",
      attrs: { src: `https://x/${ATTRIBUTE_PAYLOAD}`, filename: "f" },
    },
    "link href": {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "t",
          marks: [{ type: "link", attrs: { href: `https://x/${ATTRIBUTE_PAYLOAD}` } }],
        },
      ],
    },
  };

  for (const [attributeName, block] of Object.entries(attributeBlocks)) {
    it(`keeps a CR in the ${attributeName} inside its blockquote`, () => {
      const quoted: JSONContent = { type: "blockquote", content: [block] };
      const markdown = noteToMarkdown(noteWithDoc({ type: "doc", content: [quoted] }));
      expect(markdown.startsWith(TITLE_PREFIX)).toBe(true);
      const types = new MarkdownIt("commonmark")
        .parse(markdown.slice(TITLE_PREFIX.length), {})
        .map((token) => token.type);
      expect(types[0]).toBe("blockquote_open");
      expect(types.at(-1)).toBe("blockquote_close");
      expect(types.filter((type) => type === "blockquote_open")).toHaveLength(1);
    });
  }
});
