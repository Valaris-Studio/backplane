// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDomainSync } from "@/hooks/useDomainSync";
import { api } from "@/lib/api";
import { completionKeys } from "@/lib/query-keys";

interface Props {
  slug: string;
  sourceKind: "note" | "definition" | "prompt" | "configuration";
  sourceId?: string;
  enabled?: boolean;
}
interface Impact {
  attempts: { attempt_id: string; execution_id: string; board_id: string; kind: string; role: string; binding_known: boolean }[];
}

export function CompletionContextWarning({ slug, sourceKind, sourceId, enabled = true }: Props) {
  const { t } = useTranslation();
  const queryKey = completionKeys.contextImpact(slug, sourceKind, sourceId);
  useDomainSync("completion", queryKey);
  useDomainSync("config", queryKey);
  useDomainSync("activity.note", queryKey);
  useDomainSync("activity.definition", queryKey);
  useDomainSync("execution", queryKey);
  const impact = useQuery({
    queryKey,
    queryFn: async ({ signal }) => (await api.get<Impact>(`/workspaces/${slug}/config/completion-context-impact`, {
      signal, params: { source_kind: sourceKind, source_id: sourceId },
    })).data,
    enabled: enabled && !!slug && (sourceKind === "configuration" || !!sourceId),
    retry: false,
  });
  if (!enabled) return null;
  if (impact.isError) return <p role="status" className="text-xs text-muted-foreground">{t("completionContext.impactUnavailable")}</p>;
  if (!impact.data?.attempts.length) return null;
  return <aside role="status" className="space-y-1 rounded-md border p-3 text-sm">
    <p>{t(impact.data.attempts.some((attempt) => !attempt.binding_known) ? "completionContext.legacyWarning" : "completionContext.editWarning")}</p>
    <ul>{impact.data.attempts.map((attempt) => <li key={attempt.attempt_id}>
      {attempt.role} · {attempt.attempt_id.slice(0, 8)}
    </li>)}</ul>
    <p className="text-xs text-muted-foreground">{t("completionContext.retryHint")}</p>
  </aside>;
}
