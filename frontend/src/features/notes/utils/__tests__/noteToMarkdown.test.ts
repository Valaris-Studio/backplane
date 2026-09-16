// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { noteToMarkdown, noteMarkdownFilename } from "../noteToMarkdown";
import type { Note } from "@/types/note";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    workspace_id: "w1",
    board_id: null,
    card_id: null,
    title: "My Note",
    content: "",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    ...overrides,
  };
}

// TipTap doc helper — the content field is a JSON string of a ProseMirror doc.
function doc(...content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}
function para(...children: unknown[]) {
  return { type: "paragraph", content: children };
}
function text(value: string, marks?: unknown[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

describe("noteToMarkdown", () => {
  it("prepends the note title as an H1", () => {
    const md = noteToMarkdown(note({ title: "Release plan", content: "" }));
    expect(md.startsWith("# Release plan")).toBe(true);
  });

  it("serializes paragraphs separated by blank lines", () => {
    const md = noteToMarkdown(
      note({ content: doc(para(text("First.")), para(text("Second."))) }),
    );
    expect(md).toContain("First.\n\nSecond.");
  });

  it("serializes headings at their level", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          { type: "heading", attrs: { level: 2 }, content: [text("Section")] },
          { type: "heading", attrs: { level: 3 }, content: [text("Sub")] },
        ),
      }),
    );
    expect(md).toContain("## Section");
    expect(md).toContain("### Sub");
  });

  it("serializes bold, italic, strike and inline code marks", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          para(
            text("b", [{ type: "bold" }]),
            text(" "),
            text("i", [{ type: "italic" }]),
            text(" "),
            text("s", [{ type: "strike" }]),
            text(" "),
            text("c", [{ type: "code" }]),
          ),
        ),
      }),
    );
    expect(md).toContain("**b**");
    expect(md).toContain("*i*");
    expect(md).toContain("~~s~~");
    expect(md).toContain("`c`");
  });

  it("serializes links as markdown link syntax", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          para(
            text("docs", [{ type: "link", attrs: { href: "https://x.dev" } }]),
          ),
        ),
      }),
    );
    expect(md).toContain("[docs](https://x.dev)");
  });

  it("serializes bullet and ordered lists", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [para(text("a"))] },
              { type: "listItem", content: [para(text("b"))] },
            ],
          },
          {
            type: "orderedList",
            content: [
              { type: "listItem", content: [para(text("one"))] },
              { type: "listItem", content: [para(text("two"))] },
            ],
          },
        ),
      }),
    );
    expect(md).toContain("- a");
    expect(md).toContain("- b");
    expect(md).toContain("1. one");
    expect(md).toContain("2. two");
  });

  it("serializes blockquotes and code blocks", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          { type: "blockquote", content: [para(text("quoted"))] },
          {
            type: "codeBlock",
            attrs: { language: "ts" },
            content: [text("const x = 1;")],
          },
        ),
      }),
    );
    expect(md).toContain("> quoted");
    expect(md).toContain("```ts");
    expect(md).toContain("const x = 1;");
    expect(md).toContain("```");
  });

  it("serializes horizontal rules and hard breaks", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          para(text("line one"), { type: "hardBreak" }, text("line two")),
          { type: "horizontalRule" },
        ),
      }),
    );
    expect(md).toContain("line one  \nline two");
    expect(md).toContain("---");
  });

  it("serializes images, mentions and file attachments", () => {
    const md = noteToMarkdown(
      note({
        content: doc(
          { type: "image", attrs: { src: "https://img/x.png", alt: "diagram" } },
          para({ type: "mention", attrs: { label: "Ana" } }, text(" ping")),
          {
            type: "fileAttachment",
            attrs: { filename: "spec.pdf", src: "https://f/spec.pdf" },
          },
        ),
      }),
    );
    expect(md).toContain("![diagram](https://img/x.png)");
    expect(md).toContain("@Ana ping");
    expect(md).toContain("[spec.pdf](https://f/spec.pdf)");
  });

  it("falls back to stripped text for HTML content", () => {
    const md = noteToMarkdown(
      note({ content: "<p>Hello <b>world</b></p>" }),
    );
    expect(md).toContain("Hello world");
  });

  it("emits just the title for an empty note", () => {
    const md = noteToMarkdown(note({ title: "Empty", content: "" }));
    expect(md.trim()).toBe("# Empty");
  });
});

describe("noteMarkdownFilename", () => {
  it("slugifies the title and appends .md", () => {
    expect(noteMarkdownFilename(note({ title: "My Release Plan!" }))).toBe(
      "my-release-plan.md",
    );
  });

  it("falls back to the note id when the title is blank", () => {
    expect(noteMarkdownFilename(note({ title: "   ", id: "abc123" }))).toBe(
      "note-abc123.md",
    );
  });
});
