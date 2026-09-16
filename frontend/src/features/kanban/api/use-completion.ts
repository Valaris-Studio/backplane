// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, boardLoopKeys, cardKeys, completionKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { CardCompletion, CompletionLoopConfig, CompletionMode, CompletionPolicy, CompletionPolicyResolution, CompletionTemplateBinding } from "@/types/completion";

const base = (slug: string, boardId: string) => `/workspaces/${slug}/boards/${boardId}/completion`;

function useCompletionSync(slug: string, boardId: string) {
  const options = { filter: (event: { payload: Record<string, unknown> }) => !event.payload.board_id || event.payload.board_id === boardId };
  useDomainSync("completion", completionKeys.board(slug, boardId), options);
  useDomainSync("completion", boardKeys.detail(slug, boardId), options);
  useDomainSync("board", completionKeys.board(slug, boardId), options);
  useDomainSync("card", completionKeys.board(slug, boardId), options);
  useDomainSync("config", completionKeys.board(slug, boardId));
  useDomainSync("activity.note", completionKeys.board(slug, boardId), options);
  useDomainSync("activity.definition", completionKeys.board(slug, boardId), options);
}
export function useCompletionPolicy(slug: string, boardId: string, enabled = true) {
  useCompletionSync(slug, boardId);
  return useQuery({
    queryKey: completionKeys.policy(slug, boardId),
    queryFn: async () => (await api.get<CompletionPolicyResolution>(`${base(slug, boardId)}/policy`)).data,
    enabled: enabled && !!slug && !!boardId,
    retry: false,
  });
}
export function useCompletionPolicyPreview(
  slug: string,
  boardId: string,
  policy: CompletionPolicy | null,
  enabled = true,
  loopConfig?: CompletionLoopConfig,
  template?: CompletionTemplateBinding,
) {
  return useQuery({
    queryKey: completionKeys.preview(slug, boardId, policy, loopConfig, template),
    queryFn: async ({ signal }) => (await api.post<CompletionPolicyResolution>(`${base(slug, boardId)}/policy/preview`, { policy, ...(loopConfig === undefined ? {} : { loop_config: loopConfig }), ...(template === undefined ? {} : { template }) }, { signal })).data,
    enabled: enabled && !!slug && !!boardId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
export function useSaveCompletionPolicy(slug: string, boardId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (policy: CompletionPolicy | null) => (await api.put<CompletionPolicyResolution>(`${base(slug, boardId)}/policy`, { policy })).data,
    onSuccess: (data) => {
      client.setQueryData(completionKeys.policy(slug, boardId), data);
      void client.invalidateQueries({ queryKey: completionKeys.board(slug, boardId) });
      void client.invalidateQueries({ queryKey: boardKeys.detail(slug, boardId) });
      void client.invalidateQueries({ queryKey: boardLoopKeys.detail(slug, boardId) });
    },
  });
}
export function useCardCompletion(slug: string, boardId: string, cardId: string) {
  useCompletionSync(slug, boardId);
  useDomainSync("completion", cardKeys.detail(slug, boardId, cardId), { filter: (event) => event.payload.board_id === boardId });
  return useQuery({
    queryKey: completionKeys.card(slug, boardId, cardId),
    queryFn: async () => (await api.get<CardCompletion>(`${base(slug, boardId)}/cards/${cardId}`)).data,
    enabled: !!slug && !!boardId && !!cardId,
    retry: false,
  });
}
export function useUpdateCardCompletion(slug: string, boardId: string, cardId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (mode: CompletionMode | "retry") => mode === "retry"
      ? (await api.post<CardCompletion>(`${base(slug, boardId)}/cards/${cardId}/retry`, {})).data
      : (await api.put<CardCompletion>(`${base(slug, boardId)}/cards/${cardId}/mode`, { completion_mode: mode })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: completionKeys.card(slug, boardId, cardId) });
      void client.invalidateQueries({ queryKey: cardKeys.detail(slug, boardId, cardId) });
      void client.invalidateQueries({ queryKey: boardKeys.detail(slug, boardId) });
    },
  });
}

export function useCompletionPolicyDraft(
  slug: string,
  boardId: string,
  open: boolean,
  loopConfig?: CompletionLoopConfig,
  template?: CompletionTemplateBinding,
) {
  const current = useCompletionPolicy(slug, boardId, open);
  const [draft, setDraft] = useState<CompletionPolicy | null | undefined>();
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(undefined); setError(false); }, [boardId, open]);
  useEffect(() => {
    setDraft((previous) => previous !== undefined && JSON.stringify(previous) === JSON.stringify(current.data?.override) ? undefined : previous);
  }, [current.data?.override]);
  const value = draft === undefined ? current.data?.override ?? null : draft;
  const dirty = draft !== undefined && JSON.stringify(value) !== JSON.stringify(current.data?.override ?? null);
  const effectivePolicy = value ?? current.data?.workspace_policy;
  const proposedLoopConfig = loopConfig === undefined || !dirty || !effectivePolicy
    ? loopConfig
    : {
      ...loopConfig,
      loop_landing: effectivePolicy.landing_actor === "human" ? "human" : "merge_queue",
      merge_gate: effectivePolicy.require_forge_checks ? "forge_ci" : "none",
    };
  const preview = useCompletionPolicyPreview(slug, boardId, value, open && current.isSuccess, proposedLoopConfig, template);
  const save = useSaveCompletionPolicy(slug, boardId);
  const needsPreview = dirty || template !== undefined || (loopConfig !== undefined && !!current.data?.effective_policy);
  const canSave = !save.isPending && (!needsPreview || (preview.isSuccess && !preview.isFetching && !preview.data.incompatibilities.length && !preview.data.template_preview?.findings.length));
  return {
    current, value, dirty, canSave, error, isPending: save.isPending, loopConfig: proposedLoopConfig, preview,
    explicit: (value ?? current.data?.workspace_policy) != null,
    compatible: current.isSuccess && !current.data.incompatibilities.length && !dirty,
    onChange: (next: CompletionPolicy | null) => { setError(false); setDraft(next); },
    persist: async () => {
      if (!canSave) return false;
      if (!dirty) return true;
      try { await save.mutateAsync(value); setDraft(undefined); return true; }
      catch { setError(true); return false; }
    },
  };
}
