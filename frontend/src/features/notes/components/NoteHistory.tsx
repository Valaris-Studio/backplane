// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCurrentUser, useCurrentUserIdentity } from "@/features/notifications/api/use-current-user";
import { formatAbsolute } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import type { Note } from "@/types/note";
import { useNoteHistory } from "../api/use-note-history";
import type { NoteRevisionSummary } from "../api/note-history-types";
import { groupNoteRevisions } from "../utils/note-history-groups";
import { NoteComparison } from "./NoteComparison";

function RevisionFacts({ revision }: { revision: NoteRevisionSummary }) {
  const { t } = useTranslation();
  const actor = revision.actor;
  const name = [actor?.user_name, actor?.agent_name, actor?.api_key_name].filter(Boolean).join(" · ")
    || actor?.user_id || actor?.agent_id || actor?.api_key_id || t("notes.history.unknownActor");
  return <div className="space-y-1 text-xs text-muted-foreground">
    <p className="break-words text-foreground">{name}</p>
    <time dateTime={revision.recorded_at} className="block tabular-nums">{formatAbsolute(revision.recorded_at, "second")}</time>
    <p title={revision.channel === "mcp_reported" ? t("notes.history.channelMcpHelp") : undefined}>{t(`notes.history.operations.${revision.operation}`, { defaultValue: revision.operation })} · {t(revision.channel === "mcp_reported" ? "notes.history.channelMcp" : "notes.history.channelUnconfirmed")}</p>
    {revision.changed_fields.length > 0 && <p>{t("notes.history.changed", {
      fields: revision.changed_fields.map((field) => t(`notes.comparison.fields.${field}`, { defaultValue: field })).join(", "),
    })}</p>}
    {revision.capture_kind === "baseline" && <p>{t("notes.history.baseline")}</p>}
    {revision.capture_kind === "gap_baseline" && <p>{t("notes.history.gapBaseline")}</p>}
    {actor && <details>
      <summary className="cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("notes.history.actorDetails")}</summary>
      <dl className="space-y-1 py-1">{Object.entries(actor).filter(([key, value]) => value && !key.endsWith("_name")).map(([key, value]) => <div key={key}>
        <dt>{t(`notes.history.actorFields.${key}`, { defaultValue: key })}</dt><dd className="break-all text-foreground">{value}</dd>
      </div>)}</dl>
    </details>}
  </div>;
}

function RevisionRow({ revision, selected, onSelect }: {
  revision: NoteRevisionSummary; selected: boolean; onSelect: (revision: NoteRevisionSummary) => void;
}) {
  const { t } = useTranslation();
  return <div className={cn("space-y-1 rounded-md px-3 py-2", selected && "bg-accent/70")}>
    <button type="button" aria-pressed={selected} onClick={() => onSelect(revision)}
      className="min-h-11 w-full rounded-sm text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {t("notes.history.revision", { revision: revision.revision })}
    </button>
    <RevisionFacts revision={revision} />
  </div>;
}

function HistoryReader({ note, slug, viewerId }: { note: Note; slug: string; viewerId: string }) {
  const { t } = useTranslation();
  const history = useNoteHistory(slug, note.board_id, note.id, viewerId);
  const groups = useMemo(() => groupNoteRevisions(history.revisions), [history.revisions]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const comparisonId = useId();
  const snapshot = !history.snapshot.isError ? history.snapshot.data : undefined;

  if (history.accessLost) return <p role="alert" className="py-4 text-sm">{t("notes.history.accessLost")}</p>;

  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-3">
      <p className="text-xs text-muted-foreground">{t("notes.comparison.savedOnly")}</p>
      <Button variant="ghost" size="sm" className="min-h-11" disabled={history.list.isFetching || history.current.isFetching} onClick={() => void history.refresh()}>
        {t("notes.history.refresh")}
      </Button>
    </div>
    {history.hasChanges && <p role="status" className="text-sm">{t("notes.history.newChanges")}</p>}
    {history.list.isPending ? <p role="status" className="py-4 text-sm text-muted-foreground">{t("notes.history.loading")}</p>
      : history.list.isError ? <div className="space-y-2">
        <p role="alert" className="text-sm">{t("notes.history.loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => void history.list.refetch()}>{t("notes.history.retry")}</Button>
      </div>
      : !history.revisions.length ? <p className="py-4 text-sm text-muted-foreground">{t("notes.history.empty")}</p>
      : <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(13rem,17rem)_minmax(0,1fr)]">
        <div className="max-h-72 min-w-0 overflow-y-auto overscroll-contain md:max-h-[65dvh] md:border-r md:border-border/70 md:pr-4">
          <div className="space-y-2">{groups.map((group) => group.length === 1
            ? <RevisionRow key={group[0].revision} revision={group[0]} selected={history.selection?.selected === group[0].revision} onSelect={history.selectRevision} />
            : <div key={group[0].revision} className="space-y-1">
              <button type="button" aria-expanded={expanded.has(group[0].revision)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm font-medium hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(group[0].revision)) next.delete(group[0].revision); else next.add(group[0].revision);
                  return next;
                })}>
                {t("notes.history.group", { count: group.length })}
                <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0", expanded.has(group[0].revision) && "rotate-180")} />
              </button>
              {!expanded.has(group[0].revision) && <div className="px-3 pb-2"><RevisionFacts revision={group[0]} /></div>}
              {expanded.has(group[0].revision) && group.map((revision) => <RevisionRow key={revision.revision} revision={revision}
                selected={history.selection?.selected === revision.revision} onSelect={history.selectRevision} />)}
            </div>)}</div>
          {history.list.hasNextPage && <Button variant="outline" size="sm" className="my-3 min-h-11 w-full whitespace-normal"
            disabled={history.list.isFetchingNextPage} onClick={() => void history.list.fetchNextPage()}>{t("notes.history.loadMore")}</Button>}
        </div>
        <section id={comparisonId} className="min-w-0 space-y-4">
          {!history.selection ? <p className="py-5 text-sm text-muted-foreground">{t("notes.history.select")}</p> : <>
            <div className="flex flex-wrap gap-2">
              <Button variant={history.selection.mode === "previous" ? "secondary" : "ghost"} size="sm" className="min-h-11"
                aria-pressed={history.selection.mode === "previous"} onClick={history.compareWithPrevious}>{t("notes.comparison.previous")}</Button>
              <Button variant={history.selection.mode === "current" ? "secondary" : "ghost"} size="sm" className="min-h-11"
                aria-pressed={history.selection.mode === "current"} disabled={!history.currentVerified} onClick={history.compareWithCurrent}>
                {t("notes.comparison.current")}{history.currentRevision !== null && ` · ${t("notes.history.revision", { revision: history.currentRevision })}`}
              </Button>
            </div>
            {!history.currentVerified && <p className="text-xs text-muted-foreground">{t(history.current.isError ? "notes.history.currentError" : "notes.comparison.currentUnrecorded")}</p>}
            {history.snapshot.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("notes.history.loading")}</p>
              : history.snapshot.isError ? <div className="space-y-2">
                <p role="alert" className="text-sm">{t("notes.history.loadError")}</p>
                <Button variant="outline" size="sm" onClick={() => void history.snapshot.refetch()}>{t("notes.history.retry")}</Button>
              </div>
              : snapshot && <NoteComparison before={"before" in snapshot ? snapshot.before : undefined}
                after={"after" in snapshot ? snapshot.after : snapshot} identity={`${viewerId}/${slug}/${note.board_id ?? "workspace"}/${note.id}`} />}
          </>}
        </section>
      </div>}
  </div>;
}

function HistoryDisclosure({ note, slug, viewerId }: { note: Note; slug: string; viewerId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreSheet = useRef<(() => void) | null>(null);
  const retentionId = useId();

  function changeOpen(next: boolean) {
    if (next) {
      trigger.current?.focus({ preventScroll: true });
      const sheet = trigger.current?.closest<HTMLElement>('[role="dialog"]');
      if (sheet && !restoreSheet.current) {
        const attributes = ["inert", "aria-hidden"].map((name) => [name, sheet.getAttribute(name)] as const);
        sheet.setAttribute("inert", "");
        sheet.setAttribute("aria-hidden", "true");
        restoreSheet.current = () => {
          attributes.forEach(([name, value]) => value === null ? sheet.removeAttribute(name) : sheet.setAttribute(name, value));
          restoreSheet.current = null;
        };
      }
    } else {
      // Restore the sheet before the existing dialog trap returns focus.
      restoreSheet.current?.();
      queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
    }
    setOpen(next);
  }

  useEffect(() => () => restoreSheet.current?.(), []);

  return <div className="space-y-1">
    <button ref={trigger} type="button" aria-describedby={retentionId} aria-haspopup="dialog" onClick={() => changeOpen(true)}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <History aria-hidden="true" className="size-3.5" />{t("notes.history.action")}
    </button>
    <p id={retentionId} className="max-w-prose text-xs leading-relaxed text-muted-foreground">{t("notes.history.retention")}</p>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent aria-hidden={!open || undefined} inert={!open} className="max-w-6xl gap-4 p-4 sm:p-6">
        <DialogHeader><DialogTitle>{t("notes.history.action")}</DialogTitle></DialogHeader>
        {open && <HistoryReader note={note} slug={slug} viewerId={viewerId} />}
      </DialogContent>
    </Dialog>
  </div>;
}

export function NoteHistory({ note, slug }: { note: Note; slug: string }) {
  useCurrentUser();
  const viewerId = useCurrentUserIdentity();
  if (!viewerId) return null;
  return <HistoryDisclosure key={`${viewerId}/${slug}/${note.board_id ?? "workspace"}/${note.id}`}
    note={note} slug={slug} viewerId={viewerId} />;
}
