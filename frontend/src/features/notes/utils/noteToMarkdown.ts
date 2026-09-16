// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MarkdownManager } from "@tiptap/markdown";
import type { JSONContent } from "@tiptap/core";
import type { Note } from "@/types/note";
import { MARKDOWN_EXPORT_EXTENSIONS } from "@/lib/markdown-extensions";

// TipTap/ProseMirror JSON → Markdown export.
//
// Notes are stored as ProseMirror JSON (see extractPlainText / parseContent).
// Export re-serializes that tree to CommonMark through first-party
// @tiptap/markdown, driven by the same node vocabulary the editor uses
// (MARKDOWN_EXPORT_EXTENSIONS, which carries our emission overrides).
// The shared parity corpus backend/tests/services/notes/fixtures/
// pm_markdown_corpus.json is the contract both this and the backend
// serializer must match byte for byte.
//
// If the content is not TipTap JSON (legacy HTML or plain text), we degrade to
// stripped plain text — never render raw HTML into a .md file.

// One headless manager for the whole module: export is pure and synchronous
// with no editor instance, and building the manager resolves every extension.
const markdownManager = new MarkdownManager({
  extensions: MARKDOWN_EXPORT_EXTENSIONS,
});

/**
 * Drop empty paragraphs before serializing.
 *
 * TipTap emits a blank line for each one, so a doc padded with them exports
 * with runs of blank lines. Filtering the NODES (rather than collapsing
 * `\n{3,}` in the output) leaves deliberate blank lines inside code blocks
 * alone.
 */
function withoutEmptyParagraphs(node: JSONContent): JSONContent {
  if (!node.content) return node;
  return {
    ...node,
    content: node.content
      .filter(
        (child) =>
          child.type !== "paragraph" ||
          (child.content?.length ?? 0) > 0,
      )
      .map(withoutEmptyParagraphs),
  };
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body-only markdown (no title heading) for the given note content string. */
function bodyToMarkdown(content: string): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as JSONContent;
    if (parsed?.type === "doc") {
      return markdownManager.serialize(withoutEmptyParagraphs(parsed));
    }
  } catch {
    /* not JSON — fall through */
  }
  // Legacy HTML or plain text — never emit raw HTML into the file.
  return stripHtmlTags(content);
}

export function noteToMarkdown(note: Note): string {
  const body = bodyToMarkdown(note.content);
  const heading = `# ${note.title}`.trimEnd();
  return body ? `${heading}\n\n${body}\n` : heading;
}

export function noteMarkdownFilename(note: Note): string {
  const slug = note.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.md` : `note-${note.id}.md`;
}

export function downloadNoteMarkdown(note: Note): void {
  const blob = new Blob([noteToMarkdown(note)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = noteMarkdownFilename(note);
  anchor.click();
  window.URL.revokeObjectURL(url);
}
