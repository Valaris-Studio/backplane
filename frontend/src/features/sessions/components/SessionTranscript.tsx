// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronRight, FilePen, Link2, RotateCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api-error";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { AgentSession, ContentChannel, ContentCoverage, SessionContent } from "@/types/agent-session";
import { useSessionContents } from "../api/use-session-contents";
import { transcriptEntries } from "../utils/contents";
import { formatBytes, formatClock } from "../utils/format";
import { KindIcon } from "./CallRow";
import { ContentBody } from "./ContentBody";
import { ExcerptCheckbox, SessionExcerpt } from "./SessionExcerpt";
import { Segmented } from "./controls";
import { CallContentText } from "./PromptText";

type View = "conversation" | "everything";

const ANCHOR_PREFIX = "#content-";
const PROSE: ReadonlySet<ContentChannel> = new Set(["prompt", "reply", "reasoning", "summary", "instruction"]);

interface SessionTranscriptProps {
  slug: string;
  session: AgentSession;
}

/** What rich capture kept of the session, in source order. Absent where nothing was captured. */
export function SessionTranscript({ slug, session }: SessionTranscriptProps) {
  return <SessionTranscriptReader key={`${slug}/${session.id}`} slug={slug} session={session} />;
}

function SessionTranscriptReader({ slug, session }: SessionTranscriptProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [view, setView] = useState<View>("conversation");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const onSelect = (id: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
  const contents = useSessionContents(slug, session.id);
  const items = useMemo(() => contents.data?.pages.flatMap((page) => page.items) ?? [], [contents.data]);
  const entries = useMemo(() => transcriptEntries(items, { includeRaw: view === "everything" }), [items, view]);
  const linked = useLinkedItem(items, contents.isSuccess);

  if (contents.isPending) return null;
  if (contents.isError) {
    // A deleted session is the detail page's to explain.
    if (isApiError(contents.error) && contents.error.status === 404 && !selected.size) return null;
    const refused = isApiError(contents.error) && contents.error.status === 403;
    return (
      <TranscriptFrame headingId={headingId}>
        {selected.size ? <SessionExcerpt slug={slug} session={session} items={[]} selected={selected} hasMore={false} onClear={() => setSelected(new Set())} /> : null}
        <div className="flex flex-col items-center gap-3 px-[var(--card-padding)] py-8 text-center text-sm text-muted-foreground">
          <p>{refused ? t("sessions.contents.refused") : t("sessions.contents.loadError")}</p>
          {refused ? null : (
            <Button variant="outline" size="sm" onClick={() => void contents.refetch()}>
              <RotateCw aria-hidden />
              {t("sessions.contents.retry")}
            </Button>
          )}
        </div>
      </TranscriptFrame>
    );
  }
  // A session captured before rich capture keeps the page it always had.
  if (!items.length && !contents.hasNextPage && !selected.size) return null;

  return (
    <TranscriptFrame
      headingId={headingId}
      controls={
        <Segmented
          className="ml-auto"
          label={t("sessions.contents.filterLabel")}
          value={view}
          onChange={setView}
          options={[
            { value: "conversation", label: t("sessions.contents.filters.conversation") },
            { value: "everything", label: t("sessions.contents.filters.everything") },
          ]}
        />
      }
    >
      <SessionExcerpt slug={slug} session={session} items={items} selected={selected} hasMore={contents.hasNextPage} onClear={() => setSelected(new Set())} />
      {entries.length ? (
        <ol aria-labelledby={headingId} className="flex flex-col">
          {entries.map((entry) =>
            entry.type === "call" ? (
              <TranscriptCall key={entry.callId} slug={slug} sessionId={session.id} callId={entry.callId} parts={entry.parts} selected={selected} onSelect={onSelect} />
            ) : (
              <TranscriptMessage key={entry.item.id} slug={slug} session={session} item={entry.item} selected={selected} onSelect={onSelect} />
            ),
          )}
        </ol>
      ) : (
        <p className="px-[var(--card-padding)] py-8 text-center text-sm text-muted-foreground">{t("sessions.contents.onlyRaw")}</p>
      )}
      {contents.hasNextPage ? (
        <div className="flex flex-col items-center gap-1 border-t border-border/60 py-2">
          {linked === "beyond" ? <p className="text-[0.82rem] text-muted-foreground">{t("sessions.contents.notLoadedTarget")}</p> : null}
          <Button variant="ghost" size="sm" onClick={() => void contents.fetchNextPage()} disabled={contents.isFetchingNextPage}>
            {contents.isFetchingNextPage ? t("sessions.contents.loadingMore") : t("sessions.contents.loadMore")}
          </Button>
        </div>
      ) : null}
    </TranscriptFrame>
  );
}

function TranscriptFrame({ headingId, controls, children }: { headingId: string; controls?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-[var(--card-padding)] py-2.5">
        <h2 id={headingId} className="text-base font-bold">
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
 * does not page ahead for it: "beyond" says to load more.
 */
function useLinkedItem(items: SessionContent[], loaded: boolean): "none" | "shown" | "beyond" {
  const { hash } = useLocation();
  const target = hash.startsWith(ANCHOR_PREFIX) ? hash.slice(ANCHOR_PREFIX.length) : null;
  const present = !!target && items.some((item) => item.id === target);
  const focused = useRef<string | null>(null);

  useEffect(() => {
    if (!present || !target || focused.current === target) return;
    const element = document.getElementById(`content-${target}`);
    if (!element) return;
    focused.current = target;
    element.scrollIntoView?.({ block: "start" });
    element.focus({ preventScroll: true });
  }, [present, target]);

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
  "grid scroll-mt-[calc(var(--topbar-height)+1rem)] gap-1.5 border-t border-border/60 px-[var(--card-padding)] py-3 first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [content-visibility:auto] [contain-intrinsic-size:auto_6rem]";
const LABEL_CLASSES = "text-[0.75rem] font-bold uppercase tracking-[0.08em] text-muted-foreground";

interface ExcerptSelection {
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean) => void;
}

function TranscriptMessage({ slug, session, item, selected, onSelect }: { slug: string; session: AgentSession; item: SessionContent } & ExcerptSelection) {
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
}

function partLabel(item: SessionContent, t: (key: string, values?: Record<string, string>) => string): string {
  const part = t(`sessions.contents.parts.${item.channel}`);
  return item.display_path ? t("sessions.contents.parts.withPath", { part, path: item.display_path }) : part;
}

interface TranscriptCallProps extends ExcerptSelection {
  slug: string;
  sessionId: string;
  callId: string;
  parts: SessionContent[];
}

function TranscriptCall({ slug, sessionId, callId, parts, selected, onSelect }: TranscriptCallProps) {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const linkedId = parts.find((part) => hash === `#${itemAnchor(part)}`)?.id;
  const labelId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(!!linkedId);
  useEffect(() => { if (linkedId) setOpen(true); }, [linkedId]);
  useEffect(() => {
    if (!open || !linkedId) return;
    const element = document.getElementById(`content-${linkedId}`);
    element?.scrollIntoView?.({ block: "start" });
    element?.focus({ preventScroll: true });
  }, [open, linkedId]);
  const copy = useCopyItemLink(slug, sessionId);
  const first = parts[0]!;
  const edits = parts.some((part) => part.channel === "diff" || part.channel === "file_content");
  const summary = parts.find((part) => part.preview)?.preview?.text.split("\n", 1)[0];
  // Closed, the call still says when a part wasn't fully captured.
  const gaps = [...new Set(parts.map((part) => part.coverage).filter((coverage) => coverage !== "captured"))];

  return (
    <li id={itemAnchor(first)} tabIndex={-1} aria-labelledby={labelId} className={ITEM_CLASSES}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
            <div key={part.id} id={part === first ? undefined : itemAnchor(part)} tabIndex={-1} className="grid scroll-mt-[calc(var(--topbar-height)+1rem)] gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
}

function CoverageNote({ item }: { item: SessionContent }) {
  const { t } = useTranslation();
  if (item.coverage === "captured") return null;
  const reason = item.coverage_reason;
  const sized = item.coverage === "truncated" && reason && item.byte_count != null && item.original_byte_count != null;
  const explanation =
    reason === "secret_filter"
      ? t("sessions.contents.reasons.secret_filter", { count: item.redaction.replacements })
      : sized
        ? t(`sessions.contents.reasonsSized.${reason}`, { kept: formatBytes(item.byte_count!), original: formatBytes(item.original_byte_count!) })
        : reason
          ? t(`sessions.contents.reasons.${reason}`)
          : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.84rem] text-muted-foreground">
      <CoverageBadge coverage={item.coverage} />
      {explanation ? <span>{explanation}</span> : null}
    </p>
  );
}

function CoverageBadge({ coverage }: { coverage: ContentCoverage }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center rounded-[var(--radius-cap)] border border-dashed border-muted-foreground/45 px-1.5 py-px text-[0.76rem] font-semibold text-muted-foreground">
      {t(`sessions.contents.coverage.${coverage}`)}
    </span>
  );
}
