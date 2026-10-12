// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Frontend twin of backend `app/services/notes/media_markdown.py` — the
// markdown spelling of note images and attachments:
//
//     ![alt](src "title")
//     [filename](src "attachment; size=<bytes>; type=<mime>")
//
// The backend normalizer parses exactly this form back into image /
// fileAttachment nodes, so both exporters must emit it byte for byte (pinned by
// the shared pm_markdown_corpus.json).

export const DEFAULT_ATTACHMENT_MIME = "application/octet-stream";

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
// Characters that would otherwise start markdown syntax inside a link label.
const LABEL_SPECIALS_RE = /([\\[\]*_`~<])/g;
// `&name;` / `&#123;` would be decoded as an HTML entity on re-parse.
const ENTITY_LIKE_RE = /&(?=#?[A-Za-z0-9]+;)/g;
const NEEDS_ANGLE_DESTINATION_RE = /[\s()<>]/;

export function escapeLabel(text: string): string {
  return text.replace(LABEL_SPECIALS_RE, "\\$1").replace(ENTITY_LIKE_RE, "\\&");
}

export function linkDestination(src: string): string {
  if (!src) return "<>";
  if (NEEDS_ANGLE_DESTINATION_RE.test(src)) {
    return `<${src.replace(/</g, "\\<").replace(/>/g, "\\>")}>`;
  }
  return src;
}

export function linkTitle(title: string): string {
  return `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function imageMarkdown(attrs: Record<string, unknown>): string {
  const title = (attrs.title as string | null | undefined) || "";
  const titlePart = title ? ` ${linkTitle(title)}` : "";
  const alt = escapeLabel((attrs.alt as string | null | undefined) || "");
  const src = linkDestination((attrs.src as string | null | undefined) || "");
  return `![${alt}](${src}${titlePart})`;
}

export function attachmentTitle(fileSize: unknown, mimeType: unknown): string {
  const params = ["attachment"];
  if (typeof fileSize === "number" && Number.isInteger(fileSize) && fileSize > 0) {
    params.push(`size=${fileSize}`);
  }
  if (
    typeof mimeType === "string" &&
    mimeType !== DEFAULT_ATTACHMENT_MIME &&
    MIME_RE.test(mimeType)
  ) {
    params.push(`type=${mimeType}`);
  }
  return params.join("; ");
}

export function attachmentMarkdown(attrs: Record<string, unknown>): string {
  const name = (attrs.filename as string | undefined) || "attachment";
  const src = (attrs.src as string | null | undefined) ?? "";
  // An upload that never resolved has nothing to link to.
  if (!src) return name;
  const title = attachmentTitle(attrs.fileSize, attrs.mimeType);
  return `[${escapeLabel(name)}](${linkDestination(src)} ${linkTitle(title)})`;
}
