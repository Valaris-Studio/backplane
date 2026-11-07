// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getAttributesFromExtensions, type ExtensionAttribute } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import Link from "@tiptap/extension-link";
import { OrderedList } from "@tiptap/extension-list";
import { TableCell, TableHeader } from "@tiptap/extension-table";
import { FileAttachment } from "@/extensions/file-attachment";
import { MediaImage } from "@/extensions/media-image";
import { parseContent } from "@/lib/editor-utils";

export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
}

export interface RichChange {
  kind: "unchanged" | "changed" | "added" | "removed";
  before: RichNode[];
  after: RichNode[];
}

const MAX_ALIGNMENT_BLOCKS = 500;
const MAX_ALIGNMENT_CELLS = 100_000;
const MAX_RENDERED_CHANGE_GROUPS = 32;
const RENDERED_NODE_TYPES = new Set(["text", "paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem",
  "hardBreak", "horizontalRule", "codeBlock", "image", "fileAttachment", "table", "tableRow", "tableCell", "tableHeader",
  "taskList", "taskItem", "mention"]);
const RENDERED_MARK_TYPES = new Set(["bold", "italic", "strike", "code", "underline", "link"]);
const EDITOR_NODE_ATTRIBUTES = getAttributesFromExtensions([OrderedList, CodeBlock, MediaImage, FileAttachment, TableCell, TableHeader]);
const EDITOR_MARK_ATTRIBUTES = getAttributesFromExtensions([Link]);

export function unsupportedRichTypes(blocks: RichNode[]) {
  const unsupported = new Set<string>();
  function visit(node: RichNode) {
    if (!RENDERED_NODE_TYPES.has(node.type)) unsupported.add(node.type);
    node.marks?.forEach((mark) => { if (!RENDERED_MARK_TYPES.has(mark.type)) unsupported.add(mark.type); });
    node.content?.forEach(visit);
  }
  blocks.forEach(visit);
  return [...unsupported];
}

export function retainedText(node: RichNode): string {
  const hasBlockChildren = node.content?.some((child) => !["text", "hardBreak", "mention"].includes(child.type));
  return node.text ?? (node.type === "hardBreak" ? "\n" : node.content?.map(retainedText).join(hasBlockChildren ? "\n" : "") ?? "");
}

export function canonicalStructure(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStructure).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStructure(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function withoutEditorDefaults<T extends Pick<RichNode, "type" | "attrs">>(value: T, defaults: ExtensionAttribute[]): T {
  const knownAttributes = defaults.filter((attribute) => attribute.type === value.type);
  if (!knownAttributes.length || !value.attrs) return value;
  const attrs = { ...value.attrs };
  for (const { name, attribute } of knownAttributes) {
    if (Object.hasOwn(attrs, name) && canonicalStructure(attrs[name]) === canonicalStructure(attribute.default)) delete attrs[name];
  }
  const comparable = { ...value };
  if (Object.keys(attrs).length) comparable.attrs = attrs;
  else delete comparable.attrs;
  return comparable;
}

function textRunMarkup(node: RichNode): string | null {
  if (node.type !== "text" || typeof node.text !== "string"
    || Object.keys(node).some((key) => !["type", "text", "marks"].includes(key))) return null;
  const marks = node.marks ?? [];
  if (new Set(marks.map((mark) => mark.type)).size !== marks.length || marks.some((mark) => !RENDERED_MARK_TYPES.has(mark.type)
    || Object.keys(mark).some((key) => !["type", "attrs"].includes(key))
    || Object.keys(mark.attrs ?? {}).some((name) => !EDITOR_MARK_ATTRIBUTES.some((attribute) => attribute.type === mark.type && attribute.name === name)))) return null;
  return canonicalStructure(node.marks);
}

function comparisonNode(node: RichNode): RichNode {
  const comparable = { ...withoutEditorDefaults(node, EDITOR_NODE_ATTRIBUTES) };
  if (node.content) {
    const content: RichNode[] = [];
    let previousMarkup: string | null = null;
    for (const child of node.content.map(comparisonNode)) {
      const markup = textRunMarkup(child);
      const previous = content.at(-1);
      if (previous && markup !== null && markup === previousMarkup) previous.text = previous.text! + child.text!;
      else content.push(child);
      previousMarkup = markup;
    }
    comparable.content = content;
  }
  if (node.marks) {
    const marks = node.marks.map((mark) => withoutEditorDefaults(mark, EDITOR_MARK_ATTRIBUTES));
    if (marks.every((mark) => RENDERED_MARK_TYPES.has(mark.type)) && new Set(marks.map((mark) => mark.type)).size === marks.length) {
      marks.sort((a, b) => a.type.localeCompare(b.type));
    }
    comparable.marks = marks;
  }
  return comparable;
}

export function richBlocks(content: string): RichNode[] | null {
  let document: unknown;
  try { document = parseContent(content); } catch { return null; }
  const pending: unknown[] = [document];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object" || !("type" in node) || typeof node.type !== "string") return null;
    if (node.type === "text" && (!("text" in node) || typeof node.text !== "string" || node.text.length === 0)) return null;
    if ("text" in node && typeof node.text !== "string") return null;
    if ("attrs" in node && (node.attrs === null || typeof node.attrs !== "object" || Array.isArray(node.attrs))) return null;
    if ("marks" in node) {
      if (!Array.isArray(node.marks)) return null;
      pending.push(...node.marks);
    }
    if ("content" in node) {
      if (!Array.isArray(node.content)) return null;
      pending.push(...node.content);
    }
  }
  return (document as RichNode).content ?? [];
}

export function compareRichBlocks(before: RichNode[], after: RichNode[]): RichChange[] | null {
  if (Math.max(before.length, after.length) > MAX_ALIGNMENT_BLOCKS
    || before.length * after.length > MAX_ALIGNMENT_CELLS) return null;
  const left = before.map((node) => canonicalStructure(comparisonNode(node)));
  const right = after.map((node) => canonicalStructure(comparisonNode(node)));
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let a = left.length - 1; a >= 0; a--) {
    for (let b = right.length - 1; b >= 0; b--) {
      lengths[a]![b] = left[a] === right[b] ? lengths[a + 1]![b + 1]! + 1
        : Math.max(lengths[a + 1]![b]!, lengths[a]![b + 1]!);
    }
  }
  const changes: RichChange[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length || b < right.length) {
    const unchanged = a < left.length && b < right.length && left[a] === right[b];
    let group = changes.at(-1);
    if (!group || (group.kind === "unchanged") !== unchanged) {
      group = { kind: unchanged ? "unchanged" : "changed", before: [], after: [] };
      changes.push(group);
    }
    if (unchanged) { group.before.push(before[a++]!); group.after.push(after[b++]!); }
    else if (a < left.length && (b === right.length || lengths[a + 1]![b]! >= lengths[a]![b + 1]!)) group.before.push(before[a++]!);
    else group.after.push(after[b++]!);
  }
  if (changes.length > MAX_RENDERED_CHANGE_GROUPS) return null;
  return changes.map((change) => ({ ...change, kind: change.kind === "unchanged" ? "unchanged"
    : !change.before.length ? "added" : !change.after.length ? "removed" : "changed" }));
}

export function richDocument(blocks: RichNode[]) {
  return JSON.stringify({ type: "doc", content: blocks });
}

export function storedAttributes(blocks: RichNode[]) {
  const attributes: { name: string; value: string }[] = [];
  const links = new Set<string>();
  function visit(node: RichNode, path: string) {
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      if (value !== null && value !== undefined) attributes.push({ name: `${path} · ${name}`, value: typeof value === "string" ? value : canonicalStructure(value) });
    }
    node.marks?.forEach((mark) => {
      if (mark.type === "link" && typeof mark.attrs?.href === "string") links.add(mark.attrs.href);
      for (const [name, value] of Object.entries(mark.attrs ?? {})) {
        if (name !== "href" && value !== null && value !== undefined) attributes.push({ name: `${path} · ${mark.type} · ${name}`, value: typeof value === "string" ? value : canonicalStructure(value) });
      }
    });
    node.content?.forEach((child, index) => visit(child, `${path} / ${child.type} ${index + 1}`));
  }
  blocks.forEach((block, index) => visit(block, `${block.type} ${index + 1}`));
  return { attributes, links: [...links] };
}
