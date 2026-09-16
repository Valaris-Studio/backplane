// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import MarkdownIt from "markdown-it";
import { FileAttachment } from "@/extensions/file-attachment";

// Re-exported so existing `import { extractPlainText } from "@/lib/editor-utils"`
// keeps working. The implementation lives in the dependency-free text-utils so
// preview/filter callers don't drag tiptap + markdown-it into the main chunk —
// importing it from HERE would re-pull those heavy deps via this module's top.
export { extractPlainText } from "./text-utils";

const EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
  Image.configure({ inline: false }),
  Link.configure({ openOnClick: true }),
  FileAttachment,
  Table,
  TableRow,
  TableCell,
  TableHeader,
];

const EMPTY_DOC = { type: "doc", content: [] };

const HTML_TAG_RE = /<\/?[a-z][\s\S]*?>/i;

// Cheap heuristic: does this string look like markdown? Used only when the
// content is not JSON, not HTML, and not empty. We'd rather false-positive
// (run a plain-text string through markdown-it, which is a no-op for strings
// without any markdown markers) than false-negative (render `# Heading` as
// literal "# Heading"). The actual structural decision is made by markdown-it
// — this just decides whether to bother invoking it.
const MARKDOWN_HINT_RE = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|---\s*$|\[[^\]]+\]\([^)]+\)|\|.*\|)|(\*\*[^*]+\*\*|`[^`]+`)/m;

/**
 * Does this string carry any markdown marker worth parsing?
 *
 * Exposed for the editor's paste path, which must decide whether a text/plain
 * clipboard deserves `parseContent` at all — plain prose has to land as typed,
 * byte for byte. Deliberately the SAME predicate `parseContent` uses, so the
 * paste decision and the parse outcome can never disagree.
 */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINT_RE.test(text);
}

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/**
 * Parse content string into a TipTap-compatible ProseMirror JSON document.
 * Accepts TipTap JSON, HTML, markdown, or plain text.
 *
 * Markdown handling is intentional: card descriptions (and any field where
 * agents/humans type freeform text) are stored as raw strings. Without this
 * branch, a description like `# Heading\n- item` rendered as a single
 * paragraph containing the literal markdown source — the "flat blob" bug.
 */
export function parseContent(content: string): object {
  if (!content) return EMPTY_DOC;

  // 1. ProseMirror JSON — already canonical.
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "doc") return parsed;
  } catch { /* not JSON */ }

  // 2. HTML — TipTap handles structurally.
  if (HTML_TAG_RE.test(content)) {
    return generateJSON(content, EXTENSIONS);
  }

  // 3. Markdown — render to HTML via markdown-it, then through TipTap.
  // This branch also catches plain-text-with-no-markdown because markdown-it
  // safely emits a `<p>` for unmarked prose.
  if (MARKDOWN_HINT_RE.test(content)) {
    const html = md.render(content);
    return generateJSON(html, EXTENSIONS);
  }

  // 4. Plain text — single paragraph, preserves exact whitespace/punctuation.
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
  };
}
