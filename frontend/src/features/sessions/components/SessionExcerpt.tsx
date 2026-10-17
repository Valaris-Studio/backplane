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
import { useSelectedSessionContent } from "../api/use-selected-session-content";
import { canExcerpt } from "../utils/excerpt";
import { excerptNoteDocument, EXCERPT_NOTE_MAX_ITEMS, type ExcerptNoteDraft } from "../utils/excerpt-note";
import { selectedSourceFingerprint } from "../utils/selected-content";
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

export function SessionExcerpt({ slug, session, items, selected, hasMore, draft, onDraftChange, onClear, onActionsHeightChange, revalidateSources = false, active = true, loadedCount }: {
  slug: string; session: AgentSession; items: SessionContent[]; selected: ReadonlySet<string>; hasMore: boolean; onClear: () => void;
  draft: ExcerptNoteDraft | null; onDraftChange: (draft: ExcerptNoteDraft | null) => void;
  onActionsHeightChange?: (height: number) => void;
  revalidateSources?: boolean; active?: boolean; loadedCount?: number;
}) {
  const { t } = useTranslation();
  const privacyId = useId();
  const selectedItems = items.filter((item) => selected.has(item.id));
  const missingSelection = selectedItems.length !== selected.size || selectedItems.some((item) => !canExcerpt(item));
  const fingerprint = selectedSourceFingerprint(slug, session, selectedItems);
  const validation = useSelectedSessionContent(slug, session, selectedItems, revalidateSources && active);
  const unavailable = missingSelection || (revalidateSources && (validation.changed || validation.isError));
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(true);
  const validating = useRef(false);
  const disclosureGeneration = useRef(0);
  const [isValidating, setIsValidating] = useState(false);
  const [requestedFingerprint, setRequestedFingerprint] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const { mutate, reset, data, error, isPending } = useSessionExcerpt(slug, session.id);
  const open = active && requestedFingerprint !== null && requestedFingerprint === fingerprint && !unavailable;
  const close = useCallback(() => {
    disclosureGeneration.current += 1;
    validating.current = false;
    setIsValidating(false);
    controller.current?.abort();
    controller.current = null;
    setRequestedFingerprint(null);
    reset();
  }, [reset]);

  useEffect(() => { if (!active) close(); }, [active, close]);
  useEffect(() => {
    if (requestedFingerprint !== null && !open) close();
  }, [requestedFingerprint, open, close]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; disclosureGeneration.current += 1; controller.current?.abort(); };
  }, []);
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

  async function freshSelection(): Promise<SessionContent[] | null> {
    if (missingSelection || !active) return null;
    const expected = fingerprint;
    const generation = disclosureGeneration.current;
    const fresh = revalidateSources ? await validation.validate() : selectedItems;
    return mounted.current && activeRef.current && fingerprintRef.current === expected && disclosureGeneration.current === generation ? fresh : null;
  }

  async function preview() {
    if (validating.current) return;
    const generation = ++disclosureGeneration.current;
    validating.current = true;
    setIsValidating(true);
    const fresh = await freshSelection();
    if (!mounted.current || disclosureGeneration.current !== generation) return;
    validating.current = false;
    setIsValidating(false);
    if (!fresh) return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setRequestedFingerprint(fingerprint);
    mutate({ slug, session, items: fresh, signal: next.signal, t });
  }

  async function share() {
    if (!data || !open || validating.current) return;
    const generation = ++disclosureGeneration.current;
    validating.current = true;
    setIsValidating(true);
    const fresh = await freshSelection();
    if (!mounted.current || disclosureGeneration.current !== generation) return;
    validating.current = false;
    setIsValidating(false);
    if (!fresh || fingerprintRef.current !== requestedFingerprint) return;
    onDraftChange({ fingerprint, session, bodies: data.bodies, document: excerptNoteDocument(slug, session, data.bodies, t) });
    close();
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
      <p className="min-w-0 flex-1 basis-full text-sm tabular-nums sm:basis-auto" aria-live="polite">{t(loadedCount === undefined ? "sessions.contents.excerpt.count" : "sessions.contents.excerpt.windowCount", { selected: selected.size, loaded: loadedCount ?? items.length, count: loadedCount ?? items.length })}</p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {selected.size > 0 ? <Button variant="ghost" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" disabled={draft !== null} onClick={onClear}>{t("sessions.contents.excerpt.clear")}</Button> : null}
        <Button variant="outline" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" disabled={!selected.size || missingSelection || (revalidateSources && validation.changed) || draft !== null || isValidating} onClick={() => void preview()}>{t("sessions.contents.excerpt.preview")}</Button>
      </div>
      {isValidating ? <p role="status" className="basis-full text-xs text-muted-foreground">{t("sessions.contents.excerpt.validating")}</p> : null}
      {draft ? <ExcerptNoteDialog draft={draft} stale={missingSelection || (revalidateSources && validation.changed) || draft.fingerprint !== fingerprint}
        sourceCheckFailed={revalidateSources && validation.isError} onRecheckSources={revalidateSources ? freshSelection : undefined} onDiscard={() => onDraftChange(null)}
        beforeFirstSave={revalidateSources ? async () => (await freshSelection()) !== null && fingerprintRef.current === draft.fingerprint : undefined} /> : null}
    </div>
    <div className="grid gap-2 border-b border-border/60 px-[var(--card-padding)] py-3">
      <p className="text-xs text-muted-foreground">{t("sessions.contents.excerpt.excludedAttachments")}</p>
      {hasMore ? <p className="text-xs text-muted-foreground">{t(revalidateSources ? "sessions.contents.excerpt.moreWindows" : "sessions.contents.excerpt.moreItems")}</p> : null}
      {unavailable && !draft ? <p role="alert" className="text-sm text-destructive">{t(validation.isError ? "sessions.contents.excerpt.validationFailed" : "sessions.contents.excerpt.unavailable")}</p> : null}
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
          <Button variant="outline" disabled={data === undefined || isPending || isValidating || !!error || selectedItems.length > EXCERPT_NOTE_MAX_ITEMS || draft !== null} onClick={() => void share()}>{t("sessions.contents.excerpt.note.share")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
}
