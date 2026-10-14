// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import type { AgentSession, SessionContent } from "@/types/agent-session";

export const EXCERPT_MAX_BYTES = 2 * 1024 * 1024;

export function canExcerpt(item: SessionContent): boolean {
  return item.channel !== "attachment" && item.render === "text"
    && ["captured", "truncated", "partially_redacted"].includes(item.coverage);
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function delimiter(text: string, minimum: number): string {
  const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  return "`".repeat(Math.max(minimum, longest + 1));
}

// Inline code keeps captured metadata on one line without interpreting its markup.
function metadata(value: string | number | null): string {
  const line = String(value ?? "").replace(/[\r\n\t\u2028\u2029]/g, " ");
  const fence = delimiter(line, 1);
  return `${fence} ${line} ${fence}`;
}

function bodyBlock(text: string): string {
  const fence = delimiter(text, 3);
  return `${fence}text\n${text}\n${fence}`;
}

export function formatExcerpt(
  slug: string,
  session: AgentSession,
  bodies: { item: SessionContent; text: string }[],
  t: TFunction,
): string {
  const label = (key: string) => t(`sessions.contents.excerpt.document.${key}`);
  const sessionUrl = `${window.location.origin}/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.id)}`;
  const field = (key: string, value: string | number | null) => `- ${label(key)}: ${metadata(value)}`;
  return [
    `# ${t("sessions.contents.excerpt.title")}`,
    label("scope"),
    [field("session", session.id), field("title", session.title), field("agent", session.harness_display_name || session.harness)].join("\n"),
    ...bodies.map(({ item, text }) => [
      `## ${label("item")} ${metadata(item.id)}`,
      [
        field("time", item.occurred_at), field("role", item.role), field("channel", item.channel),
        field("source", item.source.kind), field("order", item.source.order),
        field("coverage", item.coverage),
        ...(item.coverage_reason ? [field("reason", item.coverage_reason)] : []),
        field("redactions", item.redaction.replacements),
        ...(item.redaction.filter_version ? [field("filter", item.redaction.filter_version)] : []),
        ...(item.original_byte_count != null ? [field("originalBytes", item.original_byte_count)] : []),
        field("capturedBytes", utf8Bytes(text)),
        `- ${label("link")}: <${sessionUrl}#content-${encodeURIComponent(item.id)}>`,
      ].join("\n"),
      bodyBlock(text),
    ].join("\n\n")),
    label("excluded"),
    "",
  ].join("\n\n");
}
