// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  ContextReceipt,
  ContextReceiptSummary,
  Execution,
} from "@/features/agents/api/agents";
import {
  RECEIPT_PAGE_SIZE,
  isAuthorizationLoss,
  isNotFound,
  useExecutionContextReceipt,
  useExecutionContextReceiptPage,
  useExecutionContextReceiptSync,
  type ReceiptMarker,
  type useReceiptHistoryState,
} from "@/features/agents/hooks/useExecutionContextReceipts";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatAbsolute } from "@/lib/date-format";
import { agentKeys } from "@/lib/query-keys";
import {
  ContextReceiptSnapshot,
  ContextReceiptSnapshotSkeleton,
} from "./ContextReceiptSnapshot";

type ReceiptHistoryControls = ReturnType<typeof useReceiptHistoryState>;

const PREPARED_STATUS = "prepared";
const NOT_VERIFIED = "not_verified";
const INCLUSION_TRUTH_KEYS = new Map([
  ["required_blocks_exact", "executions.receipts.requiredFoundVerbatim"],
  ["no_required_sources", "executions.receipts.noRequiredSources"],
]);

function markerOf(summary: ContextReceiptSummary | ContextReceipt): ReceiptMarker {
  return { id: summary.id, ordinal: summary.ordinal, created_at: summary.created_at };
}

export function ExecutionPromptPanel({
  slug,
  execution,
  history,
}: {
  slug: string;
  execution: Execution;
  history: ReceiptHistoryControls;
}) {
  const { t } = useTranslation();

  // An omitted count means the server predates receipts: never request their
  // routes, never certify "zero receipts" from a missing field.
  if (execution.context_receipt_count == null) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-[var(--card-padding)]">
          <p className="text-sm text-muted-foreground">{t("executions.receipts.historyUnsupported")}</p>
          <LegacyPrompt prompt={execution.input_prompt} />
        </CardContent>
      </Card>
    );
  }

  return (
    <ReceiptHistory
      key={`${slug}/${execution.id}`}
      slug={slug}
      execution={execution}
      receiptCount={execution.context_receipt_count}
      history={history}
    />
  );
}

function LegacyPrompt({ prompt }: { prompt: string | null }) {
  const { t } = useTranslation();
  const legacyPrompt = prompt ?? "";
  if (legacyPrompt.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("executions.prompt.empty")}</p>;
  }

  async function handleCopy() {
    if (await copyTextToClipboard(legacyPrompt)) toast.success(t("executions.prompt.copied"));
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <CardTitle className="text-sm">{t("executions.receipts.legacyPrompt")}</CardTitle>
        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy aria-hidden />
          {t("executions.receipts.copyPrompt")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("executions.receipts.legacyExplanation")}
      </p>
      <pre
        data-testid="execution-prompt-body"
        className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs"
      >
        {legacyPrompt}
      </pre>
    </section>
  );
}

function StateMessage({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border/60 bg-[color:var(--color-surface-2)] px-3 py-3">
      <p className="text-sm text-foreground">{children}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("executions.receipts.retry")}
        </Button>
      ) : null}
    </div>
  );
}

function ReceiptHistory({
  slug,
  execution,
  receiptCount,
  history,
}: {
  slug: string;
  execution: Execution;
  receiptCount: number;
  history: ReceiptHistoryControls;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const executionId = execution.id;
  const { history: state, select, showPage, observeNewest, viewLatest } = history;
  // Latched on a 401/403 from either receipt query. It disables both queries,
  // so the evicted cache is not silently refetched in a loop, until the reader
  // explicitly retries or refreshes.
  const [accessLost, setAccessLost] = useState(false);

  const { liveUpdatesAvailable } = useExecutionContextReceiptSync(
    slug,
    executionId,
    observeNewest,
  );

  const page = useExecutionContextReceiptPage(
    slug,
    executionId,
    state.offset,
    receiptCount > 0 && !accessLost,
  );
  const rows = page.data?.items ?? [];
  const total = page.data?.total ?? receiptCount;
  const newestOnFirstPage =
    state.offset === 0 && !page.isPlaceholderData ? page.data?.items[0] : undefined;

  // Default to the newest invocation only while nothing is selected yet; once a
  // choice exists, arrivals never move it.
  const selected = state.selected ?? (newestOnFirstPage ? markerOf(newestOnFirstPage) : null);

  useEffect(() => {
    if (!newestOnFirstPage) return;
    observeNewest(markerOf(newestOnFirstPage));
    if (!state.selected) select(markerOf(newestOnFirstPage));
  }, [newestOnFirstPage, state.selected, observeNewest, select]);

  const detail = useExecutionContextReceipt(slug, executionId, selected?.id ?? null, !accessLost);

  // Derived in render as well as latched: the latch only lands after an
  // effect, and the commit in between must already hide the cached body.
  const deniedNow = isAuthorizationLoss(page.error) || isAuthorizationLoss(detail.error);
  const authorizationLost = accessLost || deniedNow;

  useEffect(() => {
    if (!deniedNow) return;
    setAccessLost(true);
    queryClient.removeQueries({
      queryKey: agentKeys.executionContextReceiptDetails(slug, executionId),
    });
    queryClient.removeQueries({
      queryKey: agentKeys.executionContextReceipts(slug, executionId),
    });
  }, [deniedNow, queryClient, slug, executionId]);

  // Keys already scope requests; this guards against a server answering one
  // receipt's URL with another receipt's (or execution's) body.
  const selectedDetail =
    detail.data &&
    detail.data.id === selected?.id &&
    detail.data.execution_id === executionId
      ? detail.data
      : undefined;
  const isMisScopedDetail = !!detail.data && !selectedDetail;

  function retry() {
    setAccessLost(false);
    if (page.isError) void page.refetch();
    if (selected) void detail.refetch();
  }

  function refresh() {
    setAccessLost(false);
    void queryClient.invalidateQueries({
      queryKey: agentKeys.executionDetail(slug, executionId),
    });
    void queryClient.invalidateQueries({
      queryKey: agentKeys.executionContextReceipts(slug, executionId),
    });
    if (selected) {
      void queryClient.invalidateQueries({
        queryKey: agentKeys.executionContextReceipt(slug, executionId, selected.id),
      });
    }
  }

  const liveNotice = liveUpdatesAvailable ? null : (
    <p className="text-xs text-muted-foreground">{t("executions.receipts.liveUnavailable")}</p>
  );
  const refreshButton = (
    <Button variant="ghost" size="sm" onClick={refresh}>
      <RefreshCw aria-hidden />
      {t("executions.receipts.refresh")}
    </Button>
  );

  if (receiptCount === 0 && rows.length === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">
            {execution.context_binding
              ? t("executions.receipts.noSnapshotYet")
              : t("executions.receipts.notRecorded")}
          </CardTitle>
          {refreshButton}
        </CardHeader>
        <CardContent className="space-y-4">
          {liveNotice}
          <LegacyPrompt prompt={execution.input_prompt} />
        </CardContent>
      </Card>
    );
  }

  let body: ReactNode;
  if (authorizationLost) {
    body = <StateMessage onRetry={retry}>{t("executions.receipts.accessLost")}</StateMessage>;
  } else if (page.isError && !page.data) {
    body = <StateMessage onRetry={retry}>{t("executions.receipts.historyLoadFailed")}</StateMessage>;
  } else if (!selected) {
    body = page.isPending ? (
      <ContextReceiptSnapshotSkeleton />
    ) : (
      <p className="text-sm text-muted-foreground">{t("executions.receipts.notRecorded")}</p>
    );
  } else if (isNotFound(detail.error)) {
    body = <StateMessage onRetry={retry}>{t("executions.receipts.snapshotUnavailable")}</StateMessage>;
  } else if (selectedDetail) {
    body = (
      <>
        {detail.isError ? (
          <StateMessage onRetry={retry}>{t("executions.receipts.staleSnapshot")}</StateMessage>
        ) : null}
        <ContextReceiptSnapshot key={selectedDetail.id} slug={slug} receipt={selectedDetail} />
      </>
    );
  } else if (detail.isError || isMisScopedDetail) {
    body = <StateMessage onRetry={retry}>{t("executions.receipts.snapshotLoadFailed")}</StateMessage>;
  } else {
    body = <ContextReceiptSnapshotSkeleton />;
  }

  const shownReceipt =
    !authorizationLost && !isNotFound(detail.error) ? selectedDetail : undefined;

  return (
    <Card>
      <CardHeader className="gap-3">
        {authorizationLost ? (
          <div className="flex justify-end">{refreshButton}</div>
        ) : (
          <InvocationToolbar
            rows={rows}
            total={total}
            offset={state.offset}
            selected={selected}
            selectedDetail={selectedDetail}
            latestId={state.latest?.id ?? null}
            pageLoading={page.isFetching}
            onSelect={(marker) => select(marker)}
            onShowPage={showPage}
            trailing={refreshButton}
          />
        )}
        {shownReceipt ? <ReceiptIdentity receipt={shownReceipt} /> : null}
        {!authorizationLost && state.arrival && state.arrival.id !== selected?.id ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-foreground">{t("executions.receipts.newInvocation")}</span>
            <Button variant="outline" size="sm" onClick={viewLatest}>
              {t("executions.receipts.viewLatest")}
            </Button>
          </div>
        ) : null}
        {liveNotice}
      </CardHeader>
      <CardContent>
        <p role="status" aria-live="polite" className="sr-only">
          {shownReceipt
            ? t("executions.receipts.showing", { ordinal: shownReceipt.ordinal })
            : ""}
        </p>
        {body}
      </CardContent>
    </Card>
  );
}

function ReceiptIdentity({ receipt }: { receipt: ContextReceipt }) {
  const { t } = useTranslation();
  const isPrepared = receipt.status === PREPARED_STATUS;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <Badge variant="outline">
          {isPrepared ? t("executions.receipts.prepared") : receipt.status}
        </Badge>
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
          <code
            className="break-all rounded bg-muted px-1.5 py-0.5 font-mono"
            title={t("agents.executionProvider")}
          >
            {receipt.provider}
          </code>
          <span aria-hidden>/</span>
          <code
            className="break-all rounded bg-muted px-1.5 py-0.5 font-mono"
            title={t("agents.executionModel")}
          >
            {receipt.model}
          </code>
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {receipt.use_verification === NOT_VERIFIED
          ? t("executions.receipts.notVerified")
          : t("executions.receipts.useVerification", { value: receipt.use_verification })}
      </p>
      {receipt.dispatch ? (
        <InclusionTruth verification={receipt.dispatch.inclusion_verification} />
      ) : null}
    </div>
  );
}

function InclusionTruth({ verification }: { verification: string }) {
  const { t } = useTranslation();
  const knownKey = INCLUSION_TRUTH_KEYS.get(verification);
  return (
    <p className="text-sm text-muted-foreground">
      {knownKey ? (
        t(knownKey)
      ) : (
        <>
          {t("executions.receipts.inclusionVerification")}{" "}
          <code className="break-all font-mono text-xs">{verification}</code>
        </>
      )}
    </p>
  );
}

function InvocationToolbar({
  rows,
  total,
  offset,
  selected,
  selectedDetail,
  latestId,
  pageLoading,
  onSelect,
  onShowPage,
  trailing,
}: {
  rows: ContextReceiptSummary[];
  total: number;
  offset: number;
  selected: ReceiptMarker | null;
  selectedDetail: ContextReceipt | undefined;
  latestId: string | null;
  pageLoading: boolean;
  onSelect: (marker: ReceiptMarker) => void;
  onShowPage: (offset: number) => void;
  trailing: ReactNode;
}) {
  const { t } = useTranslation();
  const selectId = useId();

  function optionLabel(marker: ReceiptMarker) {
    const label = marker.created_at
      ? t("executions.receipts.optionLabel", {
          ordinal: marker.ordinal,
          time: formatAbsolute(marker.created_at, "second"),
        })
      : t("executions.receipts.optionLabelUntimed", { ordinal: marker.ordinal });
    return marker.id === latestId ? t("executions.receipts.optionLatest", { label }) : label;
  }

  // The selection stays a choosable option even when page movement or new
  // arrivals push it out of the fetched 20 rows.
  const selectedOffPage =
    selected && !rows.some((row) => row.id === selected.id)
      ? {
          ...selected,
          created_at:
            selectedDetail?.id === selected.id ? selectedDetail.created_at : selected.created_at,
        }
      : null;
  const options: ReceiptMarker[] = rows.map(markerOf);
  if (selectedOffPage) {
    const newerThanPage = rows.length === 0 || selectedOffPage.ordinal > (rows[0]?.ordinal ?? 0);
    if (newerThanPage) options.unshift(selectedOffPage);
    else options.push(selectedOffPage);
  }

  const hasPages = total > RECEIPT_PAGE_SIZE;
  const isOnlyReceipt = total <= 1 && options.length <= 1;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {isOnlyReceipt ? (
        <p className="text-sm text-foreground">
          <span className="font-semibold">{t("executions.receipts.invocation")}</span>{" "}
          {options[0] ? optionLabel(options[0]) : null}
        </p>
      ) : (
        <label htmlFor={selectId} className="text-sm font-semibold text-foreground">
          {t("executions.receipts.invocation")}
        </label>
      )}
      {isOnlyReceipt ? null : (
        <select
          id={selectId}
          value={selected?.id ?? ""}
          onChange={(event) => {
            const marker = options.find((option) => option.id === event.target.value);
            if (marker) onSelect(marker);
          }}
          className="min-h-9 min-w-0 max-w-full flex-1 rounded-md border border-border/70 bg-card px-2 py-1.5 text-sm sm:flex-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
      )}
      {hasPages ? (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={pageLoading || offset === 0}
            onClick={() => onShowPage(Math.max(0, offset - RECEIPT_PAGE_SIZE))}
          >
            {t("executions.receipts.newer")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pageLoading || offset + RECEIPT_PAGE_SIZE >= total}
            onClick={() => onShowPage(offset + RECEIPT_PAGE_SIZE)}
          >
            {t("executions.receipts.older")}
          </Button>
        </div>
      ) : null}
      <div className="ml-auto">{trailing}</div>
    </div>
  );
}
