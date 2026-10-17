// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api } from "@/lib/api";
import type { AgentSession, ContentBodyPage, SessionContent } from "@/types/agent-session";
import { canExcerpt, EXCERPT_MAX_BYTES, formatExcerpt, utf8Bytes } from "../utils/excerpt";
import { usePrivateContentRead } from "./use-session-contents";

interface ExcerptRequest {
  slug: string;
  session: AgentSession;
  items: SessionContent[];
  signal: AbortSignal;
  t: TFunction;
}

export class ExcerptTooLarge extends Error {}

export function useSessionExcerpt(slug: string, sessionId: string) {
  const read = usePrivateContentRead(slug, sessionId);
  return useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async ({ slug, session, items, signal, t }: ExcerptRequest) => {
      let declaredBytes = 0;
      for (const item of items) {
        if (!canExcerpt(item) || item.session_id !== session.id || item.byte_count === null
          || !Number.isSafeInteger(item.byte_count) || item.byte_count < 0) throw new Error("Unavailable selected content");
        declaredBytes += item.byte_count;
      }
      if (declaredBytes > EXCERPT_MAX_BYTES) throw new ExcerptTooLarge();
      let actualBytes = 0;
      const bodies: { item: SessionContent; text: string }[] = [];
      for (const item of items) {
        const parts: string[] = [];
        let offset = 0;
        while (offset <= item.byte_count!) {
          signal.throwIfAborted();
          const { data } = await read(signal, () => api.get<ContentBodyPage>(
            new URL(api.getUri({ url: `/workspaces/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.id)}/contents/${encodeURIComponent(item.id)}/body` }), window.location.origin).href,
            { params: { offset }, signal, adapter: "fetch" },
          ));
          signal.throwIfAborted();
          if (typeof data.text !== "string") throw new Error("Invalid selected body");
          const bytes = utf8Bytes(data.text);
          actualBytes += bytes;
          if (actualBytes > EXCERPT_MAX_BYTES) throw new ExcerptTooLarge();
          const end = offset + bytes;
          if (data.content_id !== item.id || data.offset !== offset || data.total_bytes !== item.byte_count
            || end > data.total_bytes
            || (data.next_offset === null ? end !== data.total_bytes : bytes === 0 || data.next_offset !== end || end >= data.total_bytes)) {
            throw new Error("Incomplete selected body");
          }
          parts.push(data.text);
          if (data.next_offset === null) break;
          offset = data.next_offset;
        }
        bodies.push({ item, text: parts.join("") });
      }
      signal.throwIfAborted();
      return { markdown: formatExcerpt(slug, session, bodies, t), bodies };
    },
  });
}
