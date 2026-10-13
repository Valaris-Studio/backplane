// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import type { AgentSession, SessionContent } from "@/types/agent-session";
import { utf8Bytes } from "./excerpt";

export const EXCERPT_NOTE_MAX_ITEMS = 256;
export const EXCERPT_NOTE_MAX_BYTES = 16 * 1024 * 1024;

export interface ExcerptNoteDraft {
  fingerprint: string;
  session: AgentSession;
  bodies: { item: SessionContent; text: string }[];
  document: string;
}

export function excerptNoteDocument(slug: string, session: AgentSession, bodies: ExcerptNoteDraft["bodies"], t: TFunction): string {
  const label = (key: string) => t(`sessions.contents.excerpt.document.${key}`);
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  // Structured text nodes keep even markup-shaped metadata literal.
  const field = (key: string, value: string | number | null) => paragraph(`${label(key)}: ${String(value ?? "")}`);
  const sessionUrl = `${window.location.origin}/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.id)}`;
  return JSON.stringify({ type: "doc", content: [
    paragraph(label("scope")),
    field("session", session.id), field("title", session.title), field("agent", session.harness_display_name || session.harness),
    ...bodies.flatMap(({ item, text }) => [
      field("item", item.id), field("time", item.occurred_at), field("role", item.role), field("channel", item.channel),
      field("source", item.source.kind), field("order", item.source.order), field("coverage", item.coverage),
      ...(item.coverage_reason ? [field("reason", item.coverage_reason)] : []),
      field("redactions", item.redaction.replacements),
      ...(item.redaction.filter_version ? [field("filter", item.redaction.filter_version)] : []),
      ...(item.original_byte_count != null ? [field("originalBytes", item.original_byte_count)] : []),
      field("capturedBytes", utf8Bytes(text)),
      paragraph(`${label("link")}: ${sessionUrl}#content-${encodeURIComponent(item.id)}`),
      { type: "codeBlock", attrs: { language: "text" }, ...(text ? { content: [{ type: "text", text }] } : {}) },
    ]),
    paragraph(label("excluded")),
  ] });
}

export function compactNoteDocument(content: string): string | null {
  try {
    const document = JSON.parse(content);
    return document?.type === "doc" ? JSON.stringify(document) : null;
  } catch {
    return null;
  }
}
