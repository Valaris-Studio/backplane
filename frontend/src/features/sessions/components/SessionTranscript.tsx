// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefCallback } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronRight, FilePen, Link2, RotateCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api-error";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { AgentSession, ContentChannel, SessionContent } from "@/types/agent-session";
import { SessionReaderActive } from "../api/use-session-contents";
import { useSessionWindow, type ContentWindowRequest } from "../api/use-session-window";
import { transcriptEntries, type TranscriptEntry } from "../utils/contents";
import { useHandoffDraft } from "../hooks/use-handoff-drafts";
import { formatClock } from "../utils/format";
import { KindIcon } from "./CallRow";
import { ContentBody, CoverageBadge, CoverageNote } from "./ContentBody";
import { ExcerptCheckbox, SessionExcerpt } from "./SessionExcerpt";
import { Segmented } from "./controls";
import { CallContentText } from "./PromptText";

type View = "conversation" | "everything";

const ANCHOR_PREFIX = "#content-";
const PROSE: ReadonlySet<ContentChannel> = new Set(["prompt", "reply", "reasoning", "summary", "instruction"]);

interface SessionTranscriptProps {
  slug: string;
  session: AgentSession;
  active?: boolean;
  headingRef?: RefCallback<HTMLHeadingElement>;
}

/** What rich capture kept in one bounded, source-ordered window. */
export function SessionTranscript({ slug, session, active = true, headingRef }: SessionTranscriptProps) {
  return <SessionReaderActive.Provider value={active}><SessionTranscriptReader key={`${slug}/${session.id}`} slug={slug} session={session} active={active} headingRef={headingRef} /></SessionReaderActive.Provider>;
}

const MAX_SELECTED_RECORDS = 1024;

function SessionTranscriptReader({ slug, session, active = true, headingRef }: SessionTranscriptProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const location = useLocation();
  const navigationType = useNavigationType();
  const routerNavigate = useNavigate();
  const anchor = location.hash.startsWith(ANCHOR_PREFIX) ? location.hash.slice(ANCHOR_PREFIX.length) : undefined;
  const returnNavigation = useReturnNavigation();
  const viewKey = `session-reader-view:${slug}/${session.id}`;
  const [view, setViewState] = useState<View>(() => returnNavigation?.readView<View>(viewKey) ?? "conversation");
  const viewEntry = useRef(location.key);
  useLayoutEffect(() => {
    if (viewEntry.current === location.key) return;
    viewEntry.current = location.key;
    // Hash replacement keeps this reader mounted but creates a new history key.
    // Carry its filter there; Back/Forward must read the destination's own value.
    if (navigationType === "REPLACE") returnNavigation?.writeView(viewKey, view);
    else setViewState(returnNavigation?.readView<View>(viewKey) ?? "conversation");
  }, [location.key, navigationType, returnNavigation, viewKey, view]);
  const setView = (next: View) => {
    returnNavigation?.writeView(viewKey, next);
    setViewState(next);
  };
  const [actionsHeight, setActionsHeight] = useState(0);
  const handoff = useHandoffDraft(slug, session.id);
  const clearHandoff = handoff.clear;
  const snapshots = handoff.state.selected;
  const selected = useMemo(() => new Set(snapshots.keys()), [snapshots]);
  const selectedItems = useMemo(() => [...snapshots.values()], [snapshots]);
  const draft = handoff.state.draft;
  const contents = useSessionWindow(slug, session.id, active, anchor);
  const items = contents.data?.items ?? [];
  const entries = useMemo(() => transcriptEntries(items, { includeRaw: view === "everything" }), [items, view]);
  const visibleItems = useMemo(() => items.filter((item) => view === "everything" || item.channel !== "native_record"), [items, view]);
  const nativeCount = items.length - visibleItems.length;
  const nativeTarget = view === "conversation" ? items.find((item) => item.id === anchor && item.channel === "native_record") : undefined;
  const heading = useRef<HTMLHeadingElement | null>(null);
  const setHeading = useCallback((element: HTMLHeadingElement | null) => { heading.current = element; headingRef?.(element); }, [headingRef]);
  const observedHash = useRef(`${location.key}:${anchor ?? ""}`);
  const focusedNavigation = useRef(0);
  const failedAnchor = useRef<string | null>(null);
  const pageScroll = useRef<{ id: string; top: number } | null>(null);
  const focusedContent = useRef<string | null>(null);
  const error = isApiError(contents.error) ? contents.error : null;
  const refused = error?.status === 401 || error?.status === 403;
  const unavailable = error?.status === 404 && error.errorCode === "content_not_found";
  const hasMore = !!contents.data?.earlier_cursor || !!contents.data?.later_cursor;
  const linkedItem = useLinkedItem(items, entries, contents.isSuccess && !contents.isPlaceholderData, active);
  const unlocated = contents.legacy && linkedItem === "beyond";

  useEffect(() => {
    const identity = `${location.key}:${anchor ?? ""}`;
    if (observedHash.current === identity) return;
    observedHash.current = identity;
    if (anchor && (contents.isPlaceholderData || !items.some((item) => item.id === anchor))) contents.navigate({ mode: "anchor", anchor_id: anchor });
  }, [anchor, location.key, items, contents.isPlaceholderData, contents.navigate]);

  useEffect(() => {
    if (!refused) return;
    clearHandoff();
  }, [refused, clearHandoff]);

  useEffect(() => {
    if (!active) return;
    const rememberFocus = () => {
      const target = document.activeElement?.closest<HTMLElement>('[id^="content-"]');
      focusedContent.current = target && items.some((item) => itemAnchor(item) === target.id) ? target.id : null;
    };
    const forgetDeliberateBlur = (event: FocusEvent) => {
      const target = event.target;
      if (event.relatedTarget !== null || !(target instanceof HTMLElement)) return;
      // A removed control also loses focus; wait until its detach is observable.
      queueMicrotask(() => {
        if (target.isConnected && document.activeElement === document.body) focusedContent.current = null;
      });
    };
    rememberFocus();
    document.addEventListener("focusin", rememberFocus);
    document.addEventListener("focusout", forgetDeliberateBlur);
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("focusout", forgetDeliberateBlur);
    };
  }, [active, items]);

  useEffect(() => {
    if (!active) return;
    const remember = () => {
      const candidates = items.map((item) => document.getElementById(`content-${item.id}`)).filter((element): element is HTMLElement => !!element);
      const visible = candidates.find((element) => element.getBoundingClientRect().bottom > 80);
      pageScroll.current = visible ? { id: visible.id, top: visible.getBoundingClientRect().top } : null;
    };
    remember();
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [active, items]);

  useLayoutEffect(() => {
    if (!active || contents.isPlaceholderData) return;
    if (unavailable || unlocated) {
      const identity = `${location.key}:${contents.navigation.request}`;
      if (failedAnchor.current !== identity) {
        failedAnchor.current = identity;
        heading.current?.scrollIntoView?.({ block: "start" });
        heading.current?.focus({ preventScroll: true });
      }
      focusedNavigation.current = contents.navigation.request;
      return;
    }
    if (!contents.isSuccess) return;
    if (contents.navigation.request > focusedNavigation.current) {
      focusedNavigation.current = contents.navigation.request;
      if (contents.navigation.mode !== "anchor") {
        heading.current?.scrollIntoView?.({ block: "start" });
        heading.current?.focus({ preventScroll: true });
      }
    } else {
      if (focusedContent.current && document.activeElement === document.body) {
        const retainedRecord = document.getElementById(focusedContent.current);
        (retainedRecord ?? heading.current)?.focus({ preventScroll: true });
        if (!retainedRecord) focusedContent.current = null;
      }
      if (pageScroll.current) {
        const retained = document.getElementById(pageScroll.current.id);
        const delta = retained ? retained.getBoundingClientRect().top - pageScroll.current.top : 0;
        if (delta) window.scrollBy({ top: delta, behavior: "instant" });
      }
    }
  }, [active, contents.dataUpdatedAt, contents.isSuccess, contents.isPlaceholderData, contents.navigation, unavailable, unlocated, location.key]);

  function navigate(request: ContentWindowRequest) {
    pageScroll.current = null;
    if (location.hash) routerNavigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true, preventScrollReset: true, state: location.state });
    contents.navigate(request);
  }

  // One identity for every retained row, acting on the committed window and selection.
  const committedSelection = useRef({ snapshots, items });
  useLayoutEffect(() => { committedSelection.current = { snapshots, items }; });
  const selectHandoff = handoff.select;
  const onSelect = useCallback((id: string, checked: boolean) => {
    const current = committedSelection.current;
    const next = new Map(current.snapshots);
    if (!checked) next.delete(id);
    else if (current.snapshots.size < MAX_SELECTED_RECORDS) {
      const item = current.items.find((candidate) => candidate.id === id);
      if (item) next.set(id, { ...item, preview: null });
    }
    if (!selectHandoff(next)) toast.error(t("sessions.contents.excerpt.note.capacity"));
  }, [selectHandoff, t]);

  const pending = contents.isFetching && (contents.isPending || contents.isPlaceholderData);
  return (
    <TranscriptFrame headingId={headingId} headingRef={setHeading} actionsHeight={actionsHeight}
      controls={<Segmented className="ml-auto" label={t("sessions.contents.filterLabel")} value={view} onChange={setView}
        options={[{ value: "conversation", label: t("sessions.contents.filters.conversation") }, { value: "everything", label: t("sessions.contents.filters.everything") }]} />}>
      <div className="grid gap-2 border-b border-border/60 px-[var(--card-padding)] py-3">
        <nav aria-label={t("sessions.contents.window.label")} className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" disabled={pending || (contents.unsupported && !contents.legacy)} onClick={() => navigate({ mode: "beginning" })}>{t("sessions.contents.window.beginning")}</Button>
          {!contents.legacy ? <>
            <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" disabled={pending || contents.unsupported} onClick={() => navigate({ mode: "latest" })}>{t("sessions.contents.window.latest")}</Button>
            <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" disabled={pending || !contents.data?.earlier_cursor} onClick={() => navigate({ mode: "earlier", cursor: contents.data!.earlier_cursor! })}>{t("sessions.contents.window.earlier")}</Button>
          </> : null}
          <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" disabled={pending || !contents.data?.later_cursor} onClick={() => navigate({ mode: "later", cursor: contents.data!.later_cursor! })}>{t("sessions.contents.window.later")}</Button>
        </nav>
        <p role="status" className="text-xs tabular-nums text-muted-foreground">{pending ? t("sessions.contents.window.loading") : items.length ? t("sessions.contents.window.range", { count: items.length, start: formatClock(items[0]!.occurred_at), end: formatClock(items.at(-1)!.occurred_at) }) : t("sessions.contents.window.scope")}</p>
        {contents.legacy ? <p className="text-xs text-muted-foreground">{t("sessions.contents.window.beginningScope")}</p> : null}
        {items.length ? <p className="text-xs text-muted-foreground">{t("sessions.contents.window.scope")}</p> : null}
        {nativeCount ? <p className="text-xs text-muted-foreground">{t("sessions.contents.window.nativeHidden", { count: nativeCount })}</p> : null}
        {snapshots.size >= MAX_SELECTED_RECORDS ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.contents.window.selectionLimit")}</p> : null}
      </div>
      {nativeTarget ? <div id={itemAnchor(nativeTarget)} tabIndex={-1} className="grid scroll-mt-[calc(var(--topbar-height)+1rem)] gap-1 border-b border-border/60 px-[var(--card-padding)] py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <p className="font-semibold">{t("sessions.contents.labels.native_record")}</p>
        <p className="text-muted-foreground">{t("sessions.contents.source.reference", { source: t(`sessions.contents.source.${nativeTarget.source.kind}`), order: nativeTarget.source.order })}</p>
        <CoverageNote item={nativeTarget} />
      </div> : null}
      {contents.changed ? <p role="status" className="border-b border-border px-[var(--card-padding)] py-3 text-sm">{t("sessions.contents.window.changed")}</p> : null}
      {contents.unsupported && !contents.legacy ? <div className="grid justify-items-start gap-3 px-[var(--card-padding)] py-6 text-sm">
        <p>{t("sessions.contents.window.unsupported")}</p>
        <Button variant="outline" size="sm" onClick={contents.readBeginningFallback}>{t("sessions.contents.window.beginningFallback")}</Button>
      </div> : unavailable ? <p role="status" className="px-[var(--card-padding)] py-6 text-sm">{t("sessions.contents.window.unavailable")}</p> : contents.isError && !contents.changed ? <div className="grid justify-items-start gap-3 px-[var(--card-padding)] py-6 text-sm text-muted-foreground">
        <p>{t(refused ? "sessions.contents.refused" : "sessions.contents.loadError")}</p>
        {!refused ? <Button variant="outline" size="sm" onClick={() => void contents.refetch()}><RotateCw aria-hidden />{t("sessions.contents.retry")}</Button> : null}
      </div> : null}
      {unlocated ? <p role="status" className="px-[var(--card-padding)] py-3 text-sm">{t("sessions.contents.window.anchorUnlocated")}</p> : null}
      <SessionExcerpt key="excerpt" slug={slug} session={session} items={selectedItems} selected={selected} hasMore={hasMore} loadedCount={items.length} revalidateSources active={active} draft={draft} onDraftChange={handoff.setDraft} handoff={handoff} onClear={() => handoff.select(new Map())} onActionsHeightChange={setActionsHeight} />
      {!refused && !unavailable ? <div aria-busy={pending}>
        {visibleItems.length ? <LoadedContentNavigation session={session} items={visibleItems} hasMore={hasMore} /> : null}
        {entries.length ? <ol aria-labelledby={headingId} className="flex flex-col">
          {entries.map((entry) => entry.type === "call"
            ? <TranscriptCall key={entry.callId} slug={slug} sessionId={session.id} callId={entry.callId} parts={entry.parts} selected={selected} onSelect={onSelect} active={active && !contents.isPlaceholderData} />
            : <TranscriptMessage key={entry.item.id} slug={slug} session={session} item={entry.item} selected={selected} onSelect={onSelect} />)}
        </ol> : contents.isSuccess ? <p className="px-[var(--card-padding)] py-8 text-center text-sm text-muted-foreground">{t(items.length ? "sessions.contents.onlyRaw" : "sessions.contents.emptyRich")}</p> : null}
      </div> : null}
    </TranscriptFrame>
  );
}

// Draft, fetch-state and tab updates re-render the reader. Retained rows and
// their navigation options skip those renders (and their timestamp formatting)
// only while every prop keeps its identity: data from the window query, the
// memoized selection set and the stable onSelect.
const LoadedContentNavigation = memo(function LoadedContentNavigation({ session, items, hasMore }: { session: AgentSession; items: SessionContent[]; hasMore: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const location = useLocation();
  const navigate = useNavigate();
  return <div className="grid gap-2 border-b border-border/60 px-[var(--card-padding)] py-3">
    <label htmlFor={id} className="sr-only">{t("sessions.contents.navigation.label")}</label>
    <select
      id={id}
      value=""
      aria-describedby={`${id}-scope`}
      className="h-10 w-full min-w-0 rounded-[var(--radius-cap)] border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-[44px] max-sm:min-w-[44px]"
      onChange={(event) => {
        if (!items.some((item) => item.id === event.target.value)) return;
        navigate({ pathname: location.pathname, search: location.search, hash: `${ANCHOR_PREFIX}${event.target.value}` }, { replace: true, preventScrollReset: true, state: location.state });
      }}
    >
      <option value="" disabled>{t("sessions.contents.navigation.label")}</option>
      {items.map((item) => <option key={item.id} value={item.id}>{t("sessions.contents.navigation.item", {
        label: messageLabel(item, session, t),
        source: t("sessions.contents.source.reference", { source: t(`sessions.contents.source.${item.source.kind}`), order: item.source.order }),
        time: formatClock(item.occurred_at),
        coverage: t(`sessions.contents.coverage.${item.coverage}`),
      })}</option>)}
    </select>
    <p id={`${id}-scope`} className="text-xs text-muted-foreground">{t(hasMore ? "sessions.contents.navigation.incomplete" : "sessions.contents.navigation.loaded")}</p>
  </div>;
});

function TranscriptFrame({ headingId, headingRef, actionsHeight, controls, children }: { headingId: string; headingRef?: RefCallback<HTMLHeadingElement>; actionsHeight: number; controls?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby={headingId}
      style={{ "--session-excerpt-actions-height": `${actionsHeight}px` } as CSSProperties}
      className="rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-[var(--card-padding)] py-2.5">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="scroll-mt-[calc(var(--topbar-height)+1rem)] rounded-[var(--radius-cap)] text-base font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("sessions.contents.title")}
        </h2>
        {controls}
      </header>
      {children}
    </section>
  );
}

/**
 * Focuses the item a `#content-<id>` link names once it is loaded. Release one
 * uses a bounded anchor request when the item is outside the current window.
 */
function useLinkedItem(items: SessionContent[], entries: TranscriptEntry[], loaded: boolean, active: boolean): "none" | "shown" | "beyond" {
  const { hash, key } = useLocation();
  const target = hash.startsWith(ANCHOR_PREFIX) ? hash.slice(ANCHOR_PREFIX.length) : null;
  const present = !!target && items.some((item) => item.id === target);
  // Grouped parts belong to TranscriptCall, which knows when its panel is open.
  const visible = !!target && (entries.some((entry) => entry.type === "message" && entry.item.id === target) || items.some((item) => item.id === target && item.channel === "native_record"));
  const appliedNavigation = useRef<{ key: string; target: string; element: HTMLElement } | null>(null);

  useEffect(() => {
    if (!visible || !target) {
      appliedNavigation.current = null;
      return;
    }
    // A compact tab return must not replay a link that already moved focus.
    const element = document.getElementById(`content-${target}`);
    if (!active || !loaded || !element || (appliedNavigation.current?.key === key && appliedNavigation.current.element === element)) return;
    element.scrollIntoView?.({ block: "start" });
    element.focus({ preventScroll: true });
    appliedNavigation.current = { key, target, element };
  }, [active, loaded, visible, target, key, entries]);

  if (!target || !loaded) return "none";
  return present ? "shown" : "beyond";
}

function itemAnchor(item: SessionContent) {
  return `content-${item.id}`;
}

function useCopyItemLink(slug: string, sessionId: string) {
  const { t } = useTranslation();
  return async (item: SessionContent) => {
    const copied = await copyTextToClipboard(`${window.location.origin}/${slug}/sessions/${sessionId}#${itemAnchor(item)}`);
    if (copied) toast.success(t("sessions.detail.linkCopied"));
    else toast.error(t("sessions.detail.copyFailed"));
  };
}

function messageLabel(item: SessionContent, session: AgentSession, t: (key: string) => string): string {
  switch (item.channel) {
    case "prompt":
      return t("sessions.contents.labels.you");
    case "reply":
      return session.harness_display_name || t("sessions.contents.labels.agent");
    case "reasoning":
    case "summary":
    case "instruction":
    case "attachment":
    case "error":
    case "native_record":
      return t(`sessions.contents.labels.${item.channel}`);
    default:
      return t(`sessions.contents.parts.${item.channel}`);
  }
}

function ItemMeta({ item, onCopy }: { item: SessionContent; onCopy: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="ml-auto flex items-center gap-2 whitespace-nowrap text-[0.78rem] tabular-nums text-muted-foreground">
      <span className="max-sm:hidden">
        {t("sessions.contents.source.reference", { source: t(`sessions.contents.source.${item.source.kind}`), order: item.source.order })}
      </span>
      <time dateTime={item.occurred_at}>{formatClock(item.occurred_at)}</time>
      <Button variant="ghost" size="icon" className="size-7 max-sm:size-11" aria-label={t("sessions.contents.copyLink")} onClick={onCopy}>
        <Link2 aria-hidden />
      </Button>
    </span>
  );
}

const ITEM_CLASSES =
  "grid scroll-mt-[calc(var(--topbar-height)+var(--session-excerpt-actions-height,0px)+1rem)] gap-1.5 border-t border-border/60 px-[var(--card-padding)] py-3 first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const LABEL_CLASSES = "text-[0.75rem] font-bold uppercase tracking-[0.08em] text-muted-foreground";

interface ExcerptSelection {
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean) => void;
}

const TranscriptMessage = memo(function TranscriptMessage({ slug, session, item, selected, onSelect }: { slug: string; session: AgentSession; item: SessionContent } & ExcerptSelection) {
  const { t } = useTranslation();
  const labelId = useId();
  const copy = useCopyItemLink(slug, session.id);
  return (
    <li id={itemAnchor(item)} tabIndex={-1} aria-labelledby={labelId} className={ITEM_CLASSES}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ExcerptCheckbox item={item} selected={selected} onSelect={onSelect} />
        <span id={labelId} className={LABEL_CLASSES}>
          {messageLabel(item, session, t)}
        </span>
        {item.display_path ? <span className="min-w-0 truncate font-mono text-[0.8rem] font-semibold">{item.display_path}</span> : null}
        <ItemMeta item={item} onCopy={() => void copy(item)} />
      </div>
      <CoverageNote item={item} />
      <ContentBody slug={slug} sessionId={session.id} content={item} prose={PROSE.has(item.channel)} emphasis={item.channel === "prompt"} />
    </li>
  );
});

function partLabel(item: SessionContent, t: (key: string, values?: Record<string, string>) => string): string {
  const part = t(`sessions.contents.parts.${item.channel}`);
  return item.display_path ? t("sessions.contents.parts.withPath", { part, path: item.display_path }) : part;
}

interface TranscriptCallProps extends ExcerptSelection {
  slug: string;
  sessionId: string;
  callId: string;
  parts: SessionContent[];
  active: boolean;
}

const TranscriptCall = memo(function TranscriptCall({ slug, sessionId, callId, parts, selected, onSelect, active }: TranscriptCallProps) {
  const { t } = useTranslation();
  const { hash, key } = useLocation();
  const linkedId = parts.find((part) => hash === `#${itemAnchor(part)}`)?.id;
  const labelId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(!!linkedId);
  const appliedNavigation = useRef<{ key: string; target: string } | null>(null);
  useEffect(() => { if (linkedId) setOpen(true); }, [linkedId, key]);
  useEffect(() => {
    if (!open || !linkedId) {
      appliedNavigation.current = null;
      return;
    }
    if (!active || (appliedNavigation.current?.key === key && appliedNavigation.current.target === linkedId)) return;
    const element = document.getElementById(`content-${linkedId}`);
    if (!element) return;
    element.scrollIntoView?.({ block: "start" });
    element.focus({ preventScroll: true });
    appliedNavigation.current = { key, target: linkedId };
  }, [active, open, linkedId, key]);
  const copy = useCopyItemLink(slug, sessionId);
  const first = parts[0]!;
  const edits = parts.some((part) => part.channel === "diff" || part.channel === "file_content");
  const summary = parts.find((part) => part.preview)?.preview?.text.split("\n", 1)[0];
  // Closed, the call still says when a part wasn't fully captured.
  const gaps = [...new Set(parts.map((part) => part.coverage).filter((coverage) => coverage !== "captured"))];

  return (
    <li id={itemAnchor(first)} tabIndex={-1} aria-labelledby={labelId} className={ITEM_CLASSES}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((current) => !current)}
          className="-mx-1 flex min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-cap)] px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
          <KindIcon Icon={edits ? FilePen : SquareTerminal} tone={edits ? "file" : "tool"} />
          <span id={labelId} className={LABEL_CLASSES}>
            {t("sessions.contents.labels.call")}
          </span>
          <span className="shrink-0 font-mono text-[0.78rem] text-muted-foreground">{callId}</span>
          {summary && !open ? <CallContentText text={summary} className="min-w-0 truncate font-mono text-[0.8rem] text-muted-foreground max-sm:hidden" /> : null}
        </button>
        {open ? null : gaps.map((coverage) => <CoverageBadge key={coverage} coverage={coverage} />)}
        <ItemMeta item={first} onCopy={() => void copy(first)} />
      </div>
      {open ? (
        <div id={panelId} className="ml-[2.1rem] grid gap-3 rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-2)] px-3 py-2.5">
          {parts.map((part) => (
            <div key={part.id} id={part === first ? undefined : itemAnchor(part)} tabIndex={-1} className="grid scroll-mt-[calc(var(--topbar-height)+var(--session-excerpt-actions-height,0px)+1rem)] gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-center gap-2">
                <ExcerptCheckbox item={part} selected={selected} onSelect={onSelect} />
                <h3 className="text-[0.78rem] font-semibold text-muted-foreground">{partLabel(part, t)}</h3>
              </div>
              <CoverageNote item={part} />
              <ContentBody slug={slug} sessionId={sessionId} content={part} prose={false} />
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
});
