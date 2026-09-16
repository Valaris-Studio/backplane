// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JSONContent, MarkdownRendererHelpers } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { StarterKit } from "@tiptap/starter-kit";

import { FileAttachment } from "@/extensions/file-attachment";
import { Mention } from "@/components/shared/editor/mention-extension";

// The extension list the markdown EXPORTER runs on — the vocabulary
// `@tiptap/markdown` needs to turn a stored ProseMirror doc back into
// CommonMark. It is deliberately separate from the editor's own extension
// lists: those carry node views, suggestion plugins and placeholders that a
// headless MarkdownManager neither needs nor can construct.
//
// Five extensions carry a `renderMarkdown` override: heading, codeBlock and
// table because upstream's built-in emission diverges from the shared parity
// corpus (backend/tests/services/notes/fixtures/pm_markdown_corpus.json),
// mention and fileAttachment because upstream renders an unrecognised atom as
// the empty string. That corpus is the contract the backend serializer must
// match byte-for-byte.

const MAX_HEADING_LEVEL = 6;

// Overriding a built-in's markdown emission takes TWO things, both forced by
// upstream's resolution order (`renderNodeToMarkdown` → `getHandlerForToken`):
//   1. a higher `priority` than the built-in's default 100 — MarkdownManager
//      registers in `sortExtensions` (descending-priority) order, not array
//      order, and the FIRST registration for a key wins;
//   2. a `parseMarkdown`, because the lookup consults the TOKEN registry before
//      the node-name registry and only specs defining `parseMarkdown` are
//      admitted to it. Without one the built-in keeps the token slot and its
//      renderer is still chosen, however high this extension's priority.
// A bare Extension suffices — it contributes no schema, so the node keeps its
// original definition and only the emission changes.
//
// This module is EXPORT-ONLY: markdown→PM parsing still runs through
// markdown-it in `parseContent`, matched by the backend normalizer. The
// `parseMarkdown` below therefore exists solely to claim the token slot and is
// never exercised — it returns null so an accidental parse falls through to the
// built-in rather than silently producing a half-formed node.
const OVERRIDE_PRIORITY = 200;

function renderOverride(
  name: string,
  renderMarkdown: (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
  ) => string,
) {
  return Extension.create({ name, priority: OVERRIDE_PRIORITY }).extend({
    parseMarkdown: () => null,
    renderMarkdown,
  });
}

/** Heading: clamp to CommonMark's 6 levels — upstream emits `attrs.level` '#'s verbatim. */
const ClampedHeading = renderOverride("heading", (node, helpers) => {
  const level = Math.min(
    MAX_HEADING_LEVEL,
    Math.max(1, Number(node.attrs?.level) || 1),
  );
  return `${"#".repeat(level)} ${helpers.renderChildren(node.content ?? [])}`;
});

/**
 * Code block: strip the ONE trailing newline markdown-it's fence content
 * carries, so no blank line precedes the closing fence. Named `codeBlock`, so
 * it also covers a mermaid diagram — which persists as an ordinary
 * ```mermaid fence (see MermaidCodeBlock) and needs no rule of its own.
 */
const ExportableCodeBlock = renderOverride("codeBlock", (node) => {
  const language = (node.attrs?.language as string) || "";
  let code = (node.content ?? []).map((child) => child.text ?? "").join("");
  if (code.endsWith("\n")) code = code.slice(0, -1);
  return `\`\`\`${language}\n${code}\n\`\`\``;
});

/** GFM cells are single-line: blocks join with a space and a literal '|' must be escaped. */
function renderTableCell(
  cell: JSONContent,
  helpers: MarkdownRendererHelpers,
): string {
  const text = (cell.content ?? [])
    .map((child) => helpers.renderChildren(child))
    .filter((block) => block.length > 0)
    .join(" ");
  return text.replace(/\|/g, "\\|");
}

function renderTableRow(
  row: JSONContent,
  helpers: MarkdownRendererHelpers,
): string {
  const cells = (row.content ?? []).map((cell) => renderTableCell(cell, helpers));
  return `| ${cells.join(" | ")} |`;
}

/**
 * Table: upstream pads cells to the column width and leaves a literal '|'
 * unescaped — the latter splits the cell on re-parse, so it is a correctness
 * bug, not a style difference. Emits compact GFM instead.
 */
const CompactTable = renderOverride("table", (node, helpers) => {
  const rows = node.content ?? [];
  const headerRow = rows[0];
  if (!headerRow) return "";
  // GFM requires a header: row one is always the header regardless of cell
  // types, and the separator is sized to its cell count.
  const lines = [renderTableRow(headerRow, helpers)];
  lines.push(`| ${(headerRow.content ?? []).map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(1)) lines.push(renderTableRow(row, helpers));
  return lines.join("\n");
});

/** Inline atom carrying only a display label — upstream renders atoms as "". */
const ExportableMention = Mention.extend({
  renderMarkdown(node: JSONContent) {
    return `@${(node.attrs?.label as string) ?? ""}`;
  },
});

/** Block atom: a link when the upload resolved, otherwise the bare filename. */
const ExportableFileAttachment = FileAttachment.extend({
  renderMarkdown(node: JSONContent) {
    const name = (node.attrs?.filename as string) || "attachment";
    const src = (node.attrs?.src as string) ?? "";
    return src ? `[${name}](${src})` : name;
  },
});

// Array order is NOT what resolves the overrides — OVERRIDE_PRIORITY is (see
// above). They are listed first only so the file reads in precedence order.
export const MARKDOWN_EXPORT_EXTENSIONS = [
  ClampedHeading,
  ExportableCodeBlock,
  CompactTable,
  StarterKit,
  Image,
  Link,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  ExportableMention,
  ExportableFileAttachment,
];
