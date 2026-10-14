// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { timelineKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { createDateTimeFormatter, formatNumber } from "@/lib/format";
import type { HistoryGeneration, HistoryOverview, HistorySearchPage, HistorySelector, HistoryWindow } from "../types";

interface Props {
  slug: string;
  boardId: string;
  generation: HistoryGeneration;
  overview: HistoryOverview;
  window?: HistoryWindow;
  hasNewActivity: boolean;
  busy: boolean;
  observing: boolean;
  onSelect: (selector: HistorySelector) => void;
  onRefresh: () => void;
  onObserve: () => void;
}

const fieldClass = "min-h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TimelineHistoryOverview({ slug, boardId, generation, overview, window, hasNewActivity, busy, observing, onSelect, onRefresh, onObserve }: Props) {
  const { t, i18n } = useTranslation();
  const dates = useMemo(() => createDateTimeFormatter({ year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }, i18n.resolvedLanguage), [i18n.resolvedLanguage]);
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState("all");
  const [text, setText] = useState("");
  const [search, setSearch] = useState<{ q: string; cursor?: string } | null>(null);
  const searchQuery = useQuery({
    queryKey: [...timelineKeys.history(slug, boardId), generation.id, "search", search],
    queryFn: async ({ signal }) => (await api.get<HistorySearchPage>(`/workspaces/${slug}/boards/${boardId}/timeline/generations/${generation.id}/search`, { params: { ...search, limit: 50 }, signal })).data,
    enabled: Boolean(search), retry: false, staleTime: Infinity, gcTime: 0,
  });
  const start = overview.first_at ? Date.parse(overview.first_at) : 0;
  const end = overview.last_at ? Date.parse(overview.last_at) : start;
  const center = date ? Date.parse(`${date}T12:00:00Z`) : end;
  const duration = period === "week" ? 7 : period === "month" ? 30 : 365;
  const periodStart = period === "all" ? start : Math.max(start, center - duration * 86_400_000 / 2);
  const periodEnd = period === "all" ? end : Math.min(end, center + duration * 86_400_000 / 2);
  const span = Math.max(1, periodEnd - periodStart);
  const peak = overview.buckets.reduce((max, bucket) => BigInt(bucket.count) > max ? BigInt(bucket.count) : max, 1n);
  const labelDate = (value: string) => dates.format(new Date(value));

  return (
    <section aria-label={t("timeline.history.overview")} className="space-y-2 border-b border-border pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium">{t("timeline.history.overview")}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{t("timeline.history.total", { total: formatNumber(BigInt(overview.event_count)) })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button className="min-h-9" size="sm" variant="ghost" onClick={onObserve} aria-pressed={observing}>{t(observing ? "timeline.history.returnReplay" : "timeline.history.observedBoard")}</Button>
          <Button className="min-h-9" size="sm" variant="outline" onClick={onRefresh}><RefreshCw aria-hidden className="mr-1 size-3.5" />{t(hasNewActivity ? "timeline.history.newActivity" : "timeline.history.refresh")}</Button>
        </div>
      </div>
      {overview.first_at && overview.last_at && <>
        <div className="relative h-12 overflow-hidden rounded-sm bg-muted/40" role="group" aria-label={t(period === "all" ? "timeline.history.activityDistribution" : "timeline.history.zoomDetail")}>
          {overview.buckets.map((bucket, index) => {
            const clippedStart = Math.max(periodStart, Date.parse(bucket.start_at));
            const clippedEnd = Math.min(periodEnd, Date.parse(bucket.end_at));
            if (clippedEnd < clippedStart || clippedEnd === clippedStart && end !== start) return null;
            const left = (clippedStart - periodStart) / span * 100;
            const width = end === start ? 100 : (clippedEnd - clippedStart) / span * 100;
            const height = Math.max(4, Number(BigInt(bucket.count) * 1000n / peak) / 10);
            return <button key={index} type="button" disabled={!bucket.first_seq || busy} onClick={() => { if (period === "all") { setDate(bucket.start_at.slice(0, 10)); onSelect({ at_seq: bucket.first_seq! }); } else onSelect({ at_time: new Date(clippedStart).toISOString() }); }}
              aria-label={t("timeline.history.bucket", { start: labelDate(bucket.start_at), end: labelDate(bucket.end_at), total: formatNumber(BigInt(bucket.count)) })}
              className="absolute inset-y-0 border-r border-background/50 hover:bg-primary/10 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              style={{ left: `${left}%`, width: `${width}%` }}>
              <span aria-hidden className="absolute inset-x-0 bottom-0 bg-primary/55" style={{ height: `${height}%` }} />
            </button>;
          })}
        </div>
        <div className="flex justify-between text-xs tabular-nums text-muted-foreground"><span>{dates.format(periodStart)}</span><span>{dates.format(periodEnd)}</span></div>
      </>}
      <div className="flex flex-wrap items-end gap-2">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (date) onSelect({ at_time: new Date(`${date}T00:00:00Z`).toISOString() }); }}>
          <label className="grid gap-1 text-xs text-muted-foreground">{t("timeline.history.date")}<input type="date" className={fieldClass} required value={date} onChange={(event) => setDate(event.target.value)} min={overview.first_at?.slice(0, 10)} max={overview.last_at?.slice(0, 10)} /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">{t("timeline.history.period")}<select className={fieldClass} value={period} onChange={(event) => setPeriod(event.target.value)}>
            {(["all", "year", "month", "week"] as const).map((value) => <option key={value} value={value}>{t(`timeline.history.periods.${value}`)}</option>)}
          </select></label>
          <Button className="min-h-9" type="submit" variant="outline" size="sm" disabled={!date || busy}>{t("timeline.history.goToDate")}</Button>
        </form>
        <div className="ml-auto flex items-center gap-1">
          <Button className="min-h-9" size="sm" variant="outline" disabled={!window?.window.previous_cursor || busy} onClick={() => onSelect({ cursor: window!.window.previous_cursor! })}><ChevronLeft aria-hidden className="size-4" />{t("timeline.history.earlier")}</Button>
          <Button className="min-h-9" size="sm" variant="outline" disabled={!window?.window.next_cursor || busy} onClick={() => onSelect({ cursor: window!.window.next_cursor! })}>{t("timeline.history.later")}<ChevronRight aria-hidden className="size-4" /></Button>
        </div>
      </div>
      {period !== "all" && overview.first_at && <p className="text-xs text-muted-foreground">{t("timeline.history.selectedPeriod", { start: dates.format(periodStart), end: dates.format(periodEnd) })} {t("timeline.history.bucketScope")}</p>}
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (text.trim()) setSearch({ q: text.trim() }); }}>
        <input type="search" maxLength={200} aria-label={t("timeline.history.searchLabel")} placeholder={t("timeline.history.searchLabel")} value={text} onChange={(event) => setText(event.target.value)} className={`${fieldClass} flex-1`} />
        <Button className="min-h-9" type="submit" size="sm" variant="outline" disabled={!text.trim() || searchQuery.isFetching}><Search aria-hidden className="mr-1 size-3.5" />{t("timeline.history.search")}</Button>
        {search && <Button className="min-h-9" type="button" size="sm" variant="ghost" onClick={() => { setSearch(null); setText(""); }}>{t("timeline.history.closeSearch")}</Button>}
      </form>
      {searchQuery.isFetching && <p role="status" className="text-xs text-muted-foreground">{t("timeline.history.searching")}</p>}
      {searchQuery.isError && <div role="alert" className="flex items-center gap-2 text-xs"><span>{t(searchQuery.error instanceof ApiError && searchQuery.error.status === 410 ? "timeline.history.expired" : "timeline.error.body")}</span><Button className="min-h-9" size="sm" variant="outline" onClick={() => { if (searchQuery.error instanceof ApiError && searchQuery.error.status === 410) onRefresh(); else void searchQuery.refetch(); }}>{t("timeline.error.retry")}</Button></div>}
      {searchQuery.data && <div className="max-h-48 overflow-y-auto" aria-label={t("timeline.history.searchResults")}>
        {!searchQuery.data.matches.length && <p className="py-2 text-xs text-muted-foreground">{t("timeline.history.noMatches")}</p>}
        {searchQuery.data.matches.map((match) => <button key={match.id} type="button" onClick={() => onSelect({ at_seq: match.seq })} className="flex min-h-9 w-full items-center gap-3 rounded px-2 py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span className="shrink-0 tabular-nums text-muted-foreground">{labelDate(match.created_at)}</span><span>{match.summary}</span></button>)}
        {searchQuery.data.next_cursor && <Button variant="ghost" size="sm" onClick={() => setSearch({ q: search!.q, cursor: searchQuery.data!.next_cursor! })}>{t("timeline.history.moreMatches")}</Button>}
      </div>}
    </section>
  );
}
