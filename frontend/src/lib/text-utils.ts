// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure plain-text helpers for card/note previews and search filters.
//
// Deliberately dependency-free: this module is statically imported on eager
// routes (KanbanCard, NoteCard, ApprovalList, board filters), so it MUST NOT
// pull in tiptap/markdown-it. The heavy `parseContent` (which DOES need those)
// lives in `editor-utils.ts` and is only reached through the lazy RichTextEditor.

/**
 * Extract plain text from TipTap JSON content for previews/cards.
 * Falls through to the raw string (HTML-stripped) if content isn't valid
 * TipTap JSON.
 */
export function extractPlainText(content: string, maxLength = 200): string {
  if (!content) return "";

  try {
    const doc = JSON.parse(content);
    if (doc?.type !== "doc") return stripHtmlTags(content);
    const parts: string[] = [];
    collectText(doc, parts);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return stripHtmlTags(content);
  }
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function collectText(
  node: {
    type?: string;
    text?: string;
    content?: unknown[];
    attrs?: { label?: unknown };
  },
  parts: string[],
) {
  if (node.text) parts.push(node.text);
  // A mention is an inline atom with no text child — surface its display label
  // as "@Label" so previews and client-side name search still match.
  if (node.type === "mention" && typeof node.attrs?.label === "string") {
    parts.push(`@${node.attrs.label}`);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      collectText(child as typeof node, parts);
    }
  }
}
