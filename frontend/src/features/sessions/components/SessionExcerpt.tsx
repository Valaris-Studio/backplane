// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { AgentSession, SessionContent } from "@/types/agent-session";
import { ExcerptTooLarge, useSessionExcerpt } from "../api/use-session-excerpt";
import { canExcerpt } from "../utils/excerpt";
import { excerptNoteDocument, EXCERPT_NOTE_MAX_ITEMS, type ExcerptNoteDraft } from "../utils/excerpt-note";
import { ExcerptNoteDialog } from "./ExcerptNoteDialog";

export function ExcerptCheckbox({ item, selected, onSelect }: {
  item: SessionContent; selected: ReadonlySet<string>; onSelect: (id: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!canExcerpt(item)) return null;
  return <Checkbox
    checked={selected.has(item.id)}
    onCheckedChange={(checked) => onSelect(item.id, checked)}
    className="min-h-8 items-center py-1 max-sm:min-h-[44px] max-sm:min-w-[44px]"
    label={<span className="sr-only">{t("sessions.contents.excerpt.selectItem", { channel: t(item.channel === "prompt" ? "sessions.contents.labels.you" : item.channel === "reply" ? "sessions.contents.labels.agent" : [`sessions.contents.labels.${item.channel}`, `sessions.contents.parts.${item.channel}`]), order: item.source.order })}</span>}
  />;
}

export function SessionExcerpt({ slug, session, items, selected, hasMore, draft, onDraftChange, onClear, onActionsHeightChange }: {
  slug: string; session: AgentSession; items: SessionContent[]; selected: ReadonlySet<string>; hasMore: boolean; onClear: () => void;
  draft: ExcerptNoteDraft | null; onDraftChange: (draft: ExcerptNoteDraft | null) => void;
  onActionsHeightChange?: (height: number) => void;
}) {
  const { t } = useTranslation();
  const privacyId = useId();
  const selectedItems = items.filter((item) => selected.has(item.id));
  const unavailable = selectedItems.length !== selected.size || selectedItems.some((item) => !canExcerpt(item));
  // A refresh may change coverage while the body request is in flight.
  const fingerprint = JSON.stringify([slug, session.id, session.title, session.harness_display_name, selectedItems, [...selected]]);
  const [requestedFingerprint, setRequestedFingerprint] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const { mutate, reset, data, error, isPending } = useSessionExcerpt();
  const open = requestedFingerprint !== null && requestedFingerprint === fingerprint && !unavailable;
  const close = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setRequestedFingerprint(null);
    reset();
  }, [reset]);

  useEffect(() => {
    if (requestedFingerprint !== null && !open) close();
  }, [requestedFingerprint, open, close]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useLayoutEffect(() => {
    const element = actions.current;
    if (!element || !onActionsHeightChange) return;
    // Wrapped controls grow with locale, zoom and selection. Anchors reserve
    // their actual height so navigation never focuses behind the sticky row.
    const measure = () => onActionsHeightChange(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onActionsHeightChange]);

  function preview() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setRequestedFingerprint(fingerprint);
    mutate({ slug, session, items: selectedItems, signal: next.signal, t });
  }

  async function copy() {
    if (!open || data === undefined || isPending) return;
    const copied = await copyTextToClipboard(data.markdown);
    if (copied) toast.success(t("sessions.contents.excerpt.copied"));
    else toast.error(t("sessions.detail.copyFailed"));
  }

  function download() {
    if (!open || data === undefined || isPending) return;
    const url = URL.createObjectURL(new Blob([data.markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "backplane-excerpt.md";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <>
    <div ref={actions} className="sticky top-[calc(var(--topbar-height)+0.5rem)] z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-2">
      <p className="min-w-0 flex-1 basis-full text-sm tabular-nums sm:basis-auto" aria-live="polite">{t("sessions.contents.excerpt.count", { selected: selected.size, loaded: items.length })}</p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {selected.size > 0 ? <Button variant="ghost" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" disabled={draft !== null} onClick={onClear}>{t("sessions.contents.excerpt.clear")}</Button> : null}
        <Button variant="outline" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" disabled={!selected.size || unavailable || draft !== null} onClick={preview}>{t("sessions.contents.excerpt.preview")}</Button>
      </div>
      {draft ? <ExcerptNoteDialog draft={draft} stale={unavailable || draft.fingerprint !== fingerprint} onDiscard={() => onDraftChange(null)} /> : null}
    </div>
    <div className="grid gap-2 border-b border-border/60 px-[var(--card-padding)] py-3">
      <p className="text-xs text-muted-foreground">{t("sessions.contents.excerpt.excludedAttachments")}</p>
      {hasMore ? <p className="text-xs text-muted-foreground">{t("sessions.contents.excerpt.moreItems")}</p> : null}
      {unavailable && !draft ? <p role="alert" className="text-sm text-destructive">{t("sessions.contents.excerpt.unavailable")}</p> : null}
    </div>
    {open ? <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-3xl max-sm:[&>button]:min-h-[44px] max-sm:[&>button]:min-w-[44px]" aria-describedby={privacyId}>
        <DialogHeader className="max-sm:min-h-[44px] max-sm:pr-[44px]">
          <DialogTitle>{t("sessions.contents.excerpt.title")}</DialogTitle>
          <p id={privacyId} className="pr-6 text-sm text-muted-foreground">{t("sessions.contents.excerpt.privacy")}</p>
        </DialogHeader>
        {isPending ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />{t("sessions.contents.excerpt.loading")}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{t(error instanceof ExcerptTooLarge ? "sessions.contents.excerpt.tooLarge" : "sessions.contents.excerpt.failed")}</p> : null}
        {data !== undefined && !isPending && !error ? <Textarea readOnly spellCheck={false} aria-label={t("sessions.contents.excerpt.previewLabel")} value={data.markdown} className="h-[min(50dvh,32rem)] resize-y font-mono text-xs leading-relaxed" /> : null}
        {selectedItems.length > EXCERPT_NOTE_MAX_ITEMS ? <p role="alert" className="text-sm text-destructive">{t("sessions.contents.excerpt.note.tooMany")}</p> : null}
        <DialogFooter className="sm:flex-wrap max-sm:[&>button]:min-h-[44px] max-sm:[&>button]:min-w-[44px]">
          <Button variant="ghost" onClick={close}>{t("sessions.contents.excerpt.cancel")}</Button>
          <Button variant="outline" onClick={() => void copy()} disabled={data === undefined || isPending || !!error}><Copy aria-hidden />{t("sessions.contents.excerpt.copy")}</Button>
          <Button onClick={download} disabled={data === undefined || isPending || !!error}><Download aria-hidden />{t("sessions.contents.excerpt.download")}</Button>
          <Button variant="outline" disabled={data === undefined || isPending || !!error || selectedItems.length > EXCERPT_NOTE_MAX_ITEMS || draft !== null} onClick={() => {
            if (!data || !open) return;
            onDraftChange({ fingerprint, session, bodies: data.bodies, document: excerptNoteDocument(slug, session, data.bodies, t) });
            close();
          }}>{t("sessions.contents.excerpt.note.share")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
}
