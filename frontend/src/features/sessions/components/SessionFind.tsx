// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SessionSearchHit } from "@/types/agent-session";
import { useSessionFind, validFindQuery, type FindScope } from "../api/use-session-find";
import { formatBytes } from "../utils/format";
import { SessionMatchText } from "./SessionMatchText";

const TARGET = "min-h-[44px] min-w-[44px]";
const GAPS = ["pending_index", "pending_upload", "withheld", "uncaptured", "unavailable", "nontext"] as const;

export function SessionFind({ slug, sessionId, onNavigate, onOpen }: {
  slug: string; sessionId: string; onNavigate: (hit: SessionSearchHit) => void; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const find = useSessionFind(slug, sessionId, onNavigate);
  const { controls, change } = find;
  const invalid = controls.draft.length > 0 && !validFindQuery(controls.draft);
  const currentPage = find.data?.pages.at(-1);
  const coverage = currentPage?.coverage;
  const showResults = !!find.data;
  const open = () => { onOpen(); change({ open: true }); window.requestAnimationFrame(() => input.current?.focus()); };
  const close = () => { change({ open: false }); opener.current?.focus(); };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); open();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  });

  return <div data-session-find="" className="grid min-w-0 gap-2">
    <Button ref={opener} variant="outline" size="sm" className={cn("justify-self-start", TARGET)} onClick={open} aria-expanded={controls.open} aria-controls={controls.open ? id : undefined}>
      <Search aria-hidden />{t("sessions.find.title")}
    </Button>
    {controls.open ? <section id={id} aria-label={t("sessions.find.title")} className="grid min-w-0 gap-3 rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-1)] p-[var(--card-padding)]">
      <div className="flex min-w-0 gap-2">
        <input ref={input} type="search" aria-label={t("sessions.find.title")} aria-invalid={invalid} aria-describedby={invalid ? `${id}-invalid` : undefined}
          value={controls.draft} onChange={(event) => change({ draft: event.target.value }, true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void find.move(event.shiftKey ? -1 : 1); }
            if (event.key === "Escape") { event.preventDefault(); if (controls.draft) change({ draft: "" }, true); else close(); }
          }}
          className="h-[44px] min-w-0 flex-1 rounded-[var(--radius-cap)] border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button variant="ghost" size="icon" className={TARGET} aria-label={t("sessions.find.close")} onClick={close}><X aria-hidden /></Button>
      </div>
      {invalid ? <p id={`${id}-invalid`} role="alert" className="text-sm text-destructive">{t("sessions.find.invalid")}</p> : null}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("sessions.find.where")}>
        {(["all", "conversation", "tools", "mcp"] as FindScope[]).map((scope) => <Button key={scope} variant={controls.scope === scope ? "secondary" : "ghost"} size="sm" className={TARGET}
          aria-pressed={controls.scope === scope} onClick={() => change({ scope }, true)}>{t(`sessions.find.${scope}`)}</Button>)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(["failures", "work"] as const).map((filter) => <label key={filter} className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={controls[filter]} onChange={(event) => change({ [filter]: event.target.checked }, true)} className="size-4 accent-primary" />
          {t(`sessions.find.${filter}`)}
        </label>)}
      </div>
      {(controls.failures || controls.work) ? <p className="text-xs text-muted-foreground">{t("sessions.find.filterHint")}</p> : null}
      <div aria-live="polite" className="grid gap-1 text-sm text-muted-foreground">
        {find.query.isFetching ? <p>{t("sessions.find.loading")}</p> : null}
        {showResults ? <>
          <p>{t(find.data!.complete ? "sessions.find.count" : "sessions.find.countSoFar", { count: find.total })}</p>
          <p className="text-xs tabular-nums">{t("sessions.find.progress", { scanned: formatBytes(find.scanned), eligible: formatBytes(currentPage?.eligible_bytes ?? 0) })}</p>
          {find.data!.complete && find.total === 0 && coverage?.index_ready && !find.query.isError ? <p>{t("sessions.find.empty")}</p> : null}
        </> : null}
        {find.stale ? <p>{t(find.staleError ? "sessions.find.changed" : "sessions.find.stale")}</p> : null}
        {coverage && !coverage.index_ready ? <p>{t("sessions.find.incomplete")}</p> : null}
      </div>
      {coverage && (GAPS.some((gap) => coverage[gap].count > 0) || coverage.linked_child_metadata.count > 0) ? <div className="grid gap-1 text-xs text-muted-foreground">
        <p className="font-semibold">{t("sessions.find.scope")}</p>
        {GAPS.filter((gap) => coverage[gap].count > 0).map((gap) => <p key={gap}>{t(`sessions.find.${gap}`, { count: coverage[gap].count })}</p>)}
        {coverage.linked_child_metadata.count ? <p>{t("sessions.find.children", { count: coverage.linked_child_metadata.count })}</p> : null}
      </div> : null}
      {find.results.length ? <ol className="grid max-h-64 min-w-0 gap-1 overflow-y-auto overscroll-contain">
        {find.results.map(({ hit, ordinal }) => <li key={`${ordinal}:${hit.source_id}:${hit.field}:${hit.byte_start}`}>
          <button type="button" onClick={() => find.select(hit, ordinal)} aria-current={controls.selected === ordinal ? "true" : undefined}
            className={cn("min-h-[44px] w-full min-w-[44px] rounded-[var(--radius-cap)] px-3 py-2 text-left text-sm whitespace-pre-wrap wrap-anywhere hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", controls.selected === ordinal && "bg-accent")}>
            {hit.source_state === "available" && hit.snippet !== null ? <SessionMatchText text={hit.snippet} range={{ byteStart: hit.byte_start, byteEnd: hit.byte_end, offset: hit.snippet_byte_start ?? 0 }} /> : t("sessions.find.sourceUnavailable")}
          </button>
        </li>)}
      </ol> : null}
      <div className="flex flex-wrap items-center gap-2">
        {find.total > 0 ? <>
          <Button variant="outline" size="icon" className={TARGET} aria-label={t("sessions.find.previous")} disabled={controls.selected <= 0 || find.query.isFetching} onClick={() => void find.move(-1)}><ArrowUp aria-hidden /></Button>
          <Button variant="outline" size="icon" className={TARGET} aria-label={t("sessions.find.next")} disabled={find.query.isFetching || (find.data?.complete && controls.selected >= find.total - 1)} onClick={() => void find.move(1)}><ArrowDown aria-hidden /></Button>
        </> : null}
        {find.data?.nextCursor && !find.staleError ? <Button variant="outline" size="sm" className={TARGET} disabled={find.query.isFetching} onClick={() => void find.continueSearch()}>{t("sessions.find.continue")}</Button> : null}
        {find.stale || (!find.data && validFindQuery(controls.draft) && !find.query.isFetching && !find.query.isError) ? <Button variant="outline" size="sm" className={TARGET} disabled={find.query.isFetching} onClick={() => void find.restart()}>{t("sessions.find.again")}</Button> : null}
        {find.query.isError && !find.staleError ? <>
          <p role="status" className="text-sm text-muted-foreground">{t("sessions.find.failed")}</p>
          <Button variant="outline" size="sm" className={TARGET} disabled={find.query.isFetching} onClick={() => void find.retry()}>{t("sessions.contents.retry")}</Button>
        </> : null}
      </div>
      {controls.selected >= 0 ? <p aria-live="polite" className="sr-only">{t(find.data?.complete ? "sessions.find.position" : "sessions.find.positionSoFar", { position: controls.selected + 1, count: find.total })}</p> : null}
    </section> : null}
  </div>;
}
