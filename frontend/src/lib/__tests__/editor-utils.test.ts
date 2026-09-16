// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";

import { parseContent, extractPlainText } from "../editor-utils";

type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: { type: string }[] };

function asDoc(value: object): PMNode {
  const doc = value as PMNode;
  expect(doc.type).toBe("doc");
  return doc;
}

// Narrow `T | undefined` after an existence assertion. Cleaner than `!` at
// every call site and survives strict null checks.
function present<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`expected ${label} to be defined`);
  return v;
}

function child(node: PMNode, i: number): PMNode {
  const arr = present(node.content, "content");
  return present(arr[i], `content[${i}]`);
}

describe("parseContent — existing branches stay green", () => {
  it("returns empty doc for empty input", () => {
    const doc = asDoc(parseContent(""));
    expect(doc.content).toEqual([]);
  });

  it("passes through ProseMirror JSON unchanged", () => {
    const pm = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    };
    expect(parseContent(JSON.stringify(pm))).toEqual(pm);
  });

  it("converts HTML through TipTap's generateJSON", () => {
    const doc = asDoc(parseContent("<h1>Title</h1><p>Body</p>"));
    const types = doc.content?.map((n) => n.type) ?? [];
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
  });
});

describe("parseContent — markdown branch (the card-description fix)", () => {
  it("converts markdown headings into heading nodes", () => {
    const doc = asDoc(parseContent("# Title"));
    const heading = child(doc, 0);
    expect(heading.type).toBe("heading");
    expect(heading.attrs?.level).toBe(1);
    expect(child(heading, 0).text).toBe("Title");
  });

  it("converts bullet lists into bulletList nodes", () => {
    const doc = asDoc(parseContent("- one\n- two\n"));
    const list = child(doc, 0);
    expect(list.type).toBe("bulletList");
    const items = present(list.content, "items");
    expect(items).toHaveLength(2);
    expect(present(items[0], "items[0]").type).toBe("listItem");
  });

  it("converts ordered lists into orderedList nodes", () => {
    const doc = asDoc(parseContent("1. one\n2. two\n"));
    const list = child(doc, 0);
    expect(list.type).toBe("orderedList");
    expect(present(list.content, "items")).toHaveLength(2);
  });

  it("preserves bold and inline-code marks", () => {
    const doc = asDoc(parseContent("**bold** and `code`"));
    const para = child(doc, 0);
    expect(para.type).toBe("paragraph");
    const textNodes = present(para.content, "para content");
    const bold = textNodes.find((n) => n.text === "bold");
    expect(bold?.marks?.some((m) => m.type === "bold")).toBe(true);
    const code = textNodes.find((n) => n.text === "code");
    expect(code?.marks?.some((m) => m.type === "code")).toBe(true);
  });

  it("converts links with href attribute", () => {
    const doc = asDoc(parseContent("[label](https://example.com)"));
    const text = child(child(doc, 0), 0);
    expect(text.text).toBe("label");
    const link = text.marks?.find((m) => m.type === "link") as
      | { type: string; attrs: { href: string } }
      | undefined;
    expect(link?.attrs.href).toBe("https://example.com");
  });

  it("converts fenced code blocks", () => {
    const doc = asDoc(parseContent("```python\nprint('hi')\n```\n"));
    const code = child(doc, 0);
    expect(code.type).toBe("codeBlock");
    expect(child(code, 0).text?.replace(/\n$/, "")).toBe("print('hi')");
  });

  it("handles the runner's Branch:/PR: convention as plain text — multi-line stays a paragraph, not a flat blob", () => {
    // Card descriptions mix freeform prose with the runner's
    // `---\nBranch: x\nPR: y` blocks. The frontend must NOT mangle that
    // structure — it should render either a paragraph with line breaks,
    // or a sequence of paragraphs. What it MUST NOT do is wrap the whole
    // thing in a single `<p>` of literal text and call it a day (the
    // pre-fix behavior the user reported).
    const desc =
      "Implement the thing.\n\n---\nBranch: feature/x\nPR: https://github.com/o/r/pull/42";
    const doc = asDoc(parseContent(desc));
    // Expect more than one block (intro paragraph + horizontal rule + branch/PR block)
    expect((doc.content?.length ?? 0)).toBeGreaterThan(1);
    // PR URL must survive verbatim somewhere in the doc.
    const flat = JSON.stringify(doc);
    expect(flat).toContain("https://github.com/o/r/pull/42");
  });

  it("plain-text without markdown markers stays a single paragraph", () => {
    const doc = asDoc(parseContent("just some words"));
    expect(present(doc.content, "doc content")).toHaveLength(1);
    const para = child(doc, 0);
    expect(para.type).toBe("paragraph");
    expect(child(para, 0).text).toBe("just some words");
  });

  it("a string containing only `---` doesn't crash and produces a doc", () => {
    const doc = asDoc(parseContent("---"));
    expect(doc.type).toBe("doc");
  });

  it("is idempotent — parsing the JSON output of a markdown parse yields the same doc", () => {
    const once = parseContent("# Title\n\nBody");
    const twice = parseContent(JSON.stringify(once));
    expect(twice).toEqual(once);
  });
});

describe("extractPlainText", () => {
  it("flattens markdown into preview text", () => {
    // After parseContent normalizes markdown to PM JSON, the preview
    // helper should walk the structured doc back to readable text — not
    // just dump the raw `# Title` markers a user shouldn't see.
    const pmJson = JSON.stringify(parseContent("# Title\n\nBody"));
    const preview = extractPlainText(pmJson);
    expect(preview).toContain("Title");
    expect(preview).toContain("Body");
    expect(preview.startsWith("#")).toBe(false);
  });

  it("returns plain markdown unchanged when content isn't yet PM JSON", () => {
    // Backend backfill normalizes notes; cards stay plain text. So the
    // preview helper must still render plain-text card descriptions
    // verbatim (truncated).
    expect(extractPlainText("just some words")).toBe("just some words");
  });
});
