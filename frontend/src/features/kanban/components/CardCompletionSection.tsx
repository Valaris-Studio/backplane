// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { useCardCompletion, useCompletionPolicy, useUpdateCardCompletion } from "../api/use-completion";
import type { CompletionMode } from "@/types/completion";
import { buildNoteLink } from "@/features/notes/utils/note-link";

interface Props { slug: string; boardId: string; cardId: string; isFrozen?: boolean }
export function CardCompletionSection(props: Props) {
  const policy = useCompletionPolicy(props.slug, props.boardId);
  if (!policy.data?.effective_policy) return null;
  return <CompletionDetails key={props.cardId} {...props} evidenceEnabled={policy.data.effective_policy.evidence_only.enabled} />;
}
function CompletionDetails({ slug, boardId, cardId, isFrozen, evidenceEnabled }: Props & { evidenceEnabled: boolean }) {
  const { t } = useTranslation();
  const { isAdmin } = useWorkspaceAdmin(slug);
  const completion = useCardCompletion(slug, boardId, cardId);
  const update = useUpdateCardCompletion(slug, boardId, cardId);
  const [mode, setMode] = useState<CompletionMode | null>(null);
  const data = completion.data;
  const candidate = data?.candidate;
  const value = mode ?? data?.completion_mode ?? "source";
  return <section aria-label={t("completionPolicy.title")} className="space-y-3 rounded-md border p-3">
    <h3 className="text-sm font-semibold">{t("completionPolicy.title")}</h3>
    {completion.isPending && <p role="status" className="text-xs text-muted-foreground">{t("common.loading")}</p>}
    {completion.isError && <div role="alert" className="text-sm text-destructive"><p>{t("completionPolicy.loadFailed")}</p><Button type="button" size="sm" variant="outline" onClick={() => void completion.refetch()}>{t("completionPolicy.reload")}</Button></div>}
    {data && <>
      <p role="status" className="text-sm">{candidate ? t(`completionPolicy.status.${candidate.status}`) : t("completionPolicy.noCandidate")}</p>
      {candidate?.summary && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{candidate.summary}</p>}
      {candidate && <dl className="space-y-1 break-all text-xs">
        <dt className="text-muted-foreground">{t("completionPolicy.sourceRevision")}</dt><dd className="font-mono">{candidate.source_sha}</dd>
        {candidate.merge_sha && <><dt className="text-muted-foreground">{t("completionPolicy.mergedRevision")}</dt><dd className="font-mono">{candidate.merge_sha}</dd></>}
      </dl>}
      {(candidate?.status === "failed" || candidate?.status === "stale") && <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("completionPolicy.retryHint")}</p>
        {candidate.status === "failed" && <Button type="button" size="sm" variant="outline" disabled={isFrozen || update.isPending} onClick={() => update.mutate("retry")}>{t("completionPolicy.retry")}</Button>}
      </div>}
      {(candidate?.status === "awaiting_review" || candidate?.status === "awaiting_validation") && data.attempts.some((attempt) => attempt.status === "claimed") && <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("completionContext.recheckHint")}</p>
        <Button type="button" size="sm" variant="outline" disabled={isFrozen || update.isPending} onClick={() => update.mutate("retry")}>{t("completionContext.recheck")}</Button>
      </div>}
      {data.attempts.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">{t("completionPolicy.history")}</summary>
          <ul className="mt-2 space-y-3">
            {data.attempts.map((attempt) => (
              <li key={attempt.id} className="space-y-2 break-words rounded-md border p-2">
                <div className="flex flex-wrap gap-x-2 font-medium">
                  <span>{t(`completionPolicy.attemptKinds.${attempt.kind}`, { defaultValue: attempt.kind })}</span>
                  <span>{t(`completionPolicy.attemptStatuses.${attempt.status}`, { defaultValue: attempt.status })}</span>
                </div>
                <time dateTime={attempt.created_at} className="text-muted-foreground">{attempt.created_at}</time>
                {attempt.result?.receipt?.status === "rejected" && <p>{t("completionContext.rejectedResult")}</p>}
                {!!attempt.result?.receipt?.changed_sources?.length && <div>
                  <p className="font-medium">{t("completionContext.changedInputs")}</p>
                  <ul>{attempt.result.receipt.changed_sources.map((source) => <li key={`${source.kind}:${source.id}`}>
                    {t(`completionContext.sourceKinds.${source.kind}`, { defaultValue: source.kind })}: {source.kind === "note"
                      ? <Link className="underline" to={buildNoteLink({ slug, noteId: source.id })}>{source.id}</Link>
                      : source.kind === "definition"
                        ? <Link className="underline" to={`/${slug}/boards/${source.id}/definitions`}>{source.id}</Link>
                        : source.id} · {t(`completionContext.changes.${source.change}`)}
                  </li>)}</ul>
                </div>}
                {attempt.result?.summary && <p className="whitespace-pre-wrap">{attempt.result.summary}</p>}
                {!!attempt.result?.checks?.length && (
                  <ul className="space-y-2">
                    {attempt.result.checks?.map((check) => (
                      <li key={check.id} className="space-y-1 border-l pl-2">
                        <p><strong>{check.id}</strong> · {t("completionPolicy.checkExitCode", { code: check.exit_code })}</p>
                        <p className="break-all font-mono">{check.source_sha}</p>
                        {check.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{check.output}</pre>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {isAdmin ? <div className="space-y-2 border-t pt-3">
        <label className="block space-y-1 text-xs font-medium">{t("completionPolicy.mode")}<select value={value} disabled={isFrozen || update.isPending} className="block h-9 w-full rounded-md border bg-background px-2 text-sm" onChange={(event) => setMode(event.target.value as CompletionMode)}>
          <option value="source">{t("completionPolicy.modes.source")}</option>
          <option value="evidence_only" disabled={!evidenceEnabled}>{t("completionPolicy.modes.evidence_only")}</option>
        </select></label>
        <p className="text-xs text-muted-foreground">{t("completionPolicy.modeHint")}</p>
        <Button type="button" size="sm" variant="outline" disabled={isFrozen || update.isPending || value === data.completion_mode} onClick={() => update.mutate(value, { onSuccess: () => setMode(null) })}>{t("completionPolicy.applyMode")}</Button>
      </div> : <p className="text-xs text-muted-foreground">{t(`completionPolicy.modes.${data.completion_mode}`)}</p>}
    </>}
    {update.isError && <p role="alert" className="text-sm text-destructive">{t("completionPolicy.mutationFailed")}</p>}
  </section>;
}
