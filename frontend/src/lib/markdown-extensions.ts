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

import { Checklist, ChecklistItem } from "@/extensions/checklist";
import { FileAttachment } from "@/extensions/file-attachment";
import { Mention } from "@/components/shared/editor/mention-extension";
import { attachmentMarkdown, imageMarkdown } from "@/lib/media-markdown";

// The extension list the markdown EXPORTER runs on — the vocabulary
// `@tiptap/markdown` needs to turn a stored ProseMirror doc back into
// CommonMark. It is deliberately separate from the editor's own extension
// lists: those carry node views, suggestion plugins and placeholders that a
// headless MarkdownManager neither needs nor can construct.
//
// Eight extensions carry a `renderMarkdown` override: heading, codeBlock,
// blockquote, table, image and taskItem because upstream's built-in emission
// diverges from the shared parity corpus
// (backend/tests/services/notes/fixtures/pm_markdown_corpus.json),
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

const MIN_FENCE_LENGTH = 3;
// A backtick in a backtick fence's info string invalidates the fence, and a
// line break ends it early — either lets a language attr forge markdown.
// eslint-disable-next-line no-control-regex
const FENCE_INFO_BREAKOUT = /[`\x00-\x1f\x7f]/;

/** A backtick fence no line of `code` can close: longer than its longest run. */
function codeFenceFor(code: string): string {
  // A reduce, not Math.max(...runs): spreading one argument per run overflows
  // the call stack on large captured bodies.
  const longestRun = (code.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  return "`".repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
}

function safeFenceInfo(language: unknown): string {
  if (typeof language !== "string") return "";
  const trimmed = language.replace(/^ +| +$/g, "");
  return FENCE_INFO_BREAKOUT.test(trimmed) ? "" : trimmed;
}

/**
 * Code block: strip the ONE trailing newline markdown-it's fence content
 * carries, so no blank line precedes the closing fence. The fence outgrows any
 * backtick run in the body, so captured text stays one literal block. Named
 * `codeBlock`, so it also covers a mermaid diagram — which persists as an
 * ordinary ```mermaid fence (see MermaidCodeBlock) and needs no rule of its own.
 */
const ExportableCodeBlock = renderOverride("codeBlock", (node) => {
  const language = safeFenceInfo(node.attrs?.language);
  let code = (node.content ?? []).map((child) => child.text ?? "").join("");
  if (code.endsWith("\n")) code = code.slice(0, -1);
  const fence = codeFenceFor(code);
  return `${fence}${language}\n${code}\n${fence}`;
});

/**
 * Blockquote: only an empty line gets a bare `>` — upstream also collapses
 * whitespace-only lines, which drops the whitespace of a quoted code line.
 */
const LiteralBlockquote = renderOverride("blockquote", (node, helpers) =>
  (node.content ?? [])
    .map((child, index) =>
      (helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]))
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n"),
    )
    .join("\n>\n"),
);

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

/**
 * Block atom: an `"attachment; size=…; type=…"`-titled link once the upload
 * resolved (the form the backend parses back into the node), otherwise the
 * bare filename.
 */
const ExportableFileAttachment = FileAttachment.extend({
  renderMarkdown(node: JSONContent) {
    return attachmentMarkdown(node.attrs ?? {});
  },
});

/** Image: upstream drops the title and leaves `]`/spaces in alt/src unescaped. */
const ExportableImage = renderOverride("image", (node) =>
  imageMarkdown(node.attrs ?? {}),
);

const NESTED_LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
// Continuation lines indent to the `- ` bullet, not past the box: four or more
// spaces beyond it would turn a nested list into paragraph text on re-parse.
const TASK_ITEM_INDENT = "  ";

/**
 * Task item: `- [ ]`/`- [x]` with nested blocks indented by the bullet width
 * (upstream indents by the whole prefix). An item whose lead paragraph was
 * dropped as empty keeps an empty first line, so its sub-list is not hoisted
 * onto the box's line — the backend's `_serialize_task_item`, line for line.
 */
const ExportableChecklistItem = ChecklistItem.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    const box = node.attrs?.checked === true ? "- [x]" : "- [ ]";
    const blocks = node.content ?? [];
    const lead = blocks[0]?.type === "paragraph" ? blocks[0] : undefined;
    const rest = lead ? blocks.slice(1) : blocks;
    let body = lead ? helpers.renderChildren([lead]) : "";
    let previousType = "paragraph";
    for (const block of rest) {
      const tight = NESTED_LIST_TYPES.has(block.type ?? "") && previousType === "paragraph";
      body += (tight ? "\n" : "\n\n") + helpers.renderChildren([block]);
      previousType = block.type ?? "";
    }
    const [first = "", ...continuation] = body.split("\n");
    return [first ? `${box} ${first}` : box, ...continuation.map((line) => `${TASK_ITEM_INDENT}${line}`)].join("\n");
  },
});

// Array order is NOT what resolves the overrides — OVERRIDE_PRIORITY is (see
// above). They are listed first only so the file reads in precedence order.
export const MARKDOWN_EXPORT_EXTENSIONS = [
  ClampedHeading,
  ExportableCodeBlock,
  LiteralBlockquote,
  CompactTable,
  ExportableImage,
  StarterKit,
  Image,
  Link,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  ExportableMention,
  ExportableFileAttachment,
  Checklist,
  ExportableChecklistItem,
];
