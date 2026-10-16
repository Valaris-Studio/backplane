// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { sessionKeys } from "@/lib/query-keys";
import type { AgentSession } from "@/types/agent-session";
import { usePromptsHidden } from "./use-hide-prompts";

// Breadcrumb label for /:slug/sessions/:sessionId. Reads the detail page's
// cache without fetching; a title is a first prompt, so presenter mode and an
// unloaded session both fall back to the plain word.
export function useSessionCrumb(slug: string, sessionId: string | undefined): string | undefined {
  const { t } = useTranslation();
  const promptsHidden = usePromptsHidden();
  const client = useQueryClient();
  const queryKey = useMemo(() => sessionKeys.detail(slug, sessionId ?? ""), [slug, sessionId]);
  // Observe the cache without changing the fetching observer's query options.
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === hashKey(queryKey)) notify();
  }), [client, queryKey]);
  const snapshot = useCallback(() => client.getQueryData<AgentSession | null>(queryKey), [client, queryKey]);
  const data = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!sessionId) return undefined;
  return !promptsHidden && data?.title ? data.title : t("sessions.detail.label");
}
