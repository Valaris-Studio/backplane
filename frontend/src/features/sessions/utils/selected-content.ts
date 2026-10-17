// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentSession, SessionContent } from "@/types/agent-session";

export function selectedSourceFingerprint(slug: string, session: AgentSession, items: readonly SessionContent[]): string {
  return JSON.stringify([
    slug, session.id, session.title, session.harness, session.harness_display_name,
    [...items].sort((left, right) => left.id.localeCompare(right.id)).map((item) => [
      item.id, item.session_id, item.event_id, item.call_id, item.parent_call_id, item.turn_id,
      item.role, item.channel, item.display_path, item.media_type, item.coverage,
      item.coverage_reason, item.byte_count, item.original_byte_count, item.sha256,
      item.redaction.filter_version, item.redaction.replacements,
      item.source.kind, item.source.order, item.occurred_at, item.render,
    ]),
  ]);
}
