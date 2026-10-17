// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import type { ContentCoverage, SessionContent } from "@/types/agent-session";
import { useContentBodyPages, useContentImage, useDownloadContent } from "../api/use-session-contents";
import { usePromptsHidden } from "../hooks/use-hide-prompts";
import { formatBytes } from "../utils/format";
import { ContentMarkdown } from "./ContentMarkdown";
import { CallContentText } from "./PromptText";

type ContentFailure = "refused" | "gone" | "storage" | "failed";

// 403: the viewer lost access; 404/410: the body went away; 503: the store
// is down or a stored body is damaged, which a retry may outlast.
function failureOf(error: unknown): ContentFailure {
  if (!isApiError(error)) return "failed";
  if (error.status === 403) return "refused";
  if (error.status === 404 || error.status === 410) return "gone";
  if (error.status === 503) return "storage";
  return "failed";
}

function FailureNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const failure = failureOf(error);
  const message = {
    refused: t("sessions.contents.refused"),
    gone: t("sessions.contents.body.gone"),
    storage: t("sessions.contents.body.storage"),
    failed: t("sessions.contents.body.failed"),
  }[failure];
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.84rem] text-muted-foreground">
      {message}
      {failure === "storage" || failure === "failed" ? (
        <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={onRetry}>
          <RotateCw aria-hidden />
          {t("sessions.contents.retry")}
        </Button>
      ) : null}
    </p>
  );
}

const TEXT_CLASSES = "max-w-[76ch] whitespace-pre-wrap wrap-anywhere text-[0.92rem] leading-relaxed";

function TextBlock({ text, markdown, emphasis }: { text: string; markdown: boolean; emphasis?: boolean }) {
  const hidden = usePromptsHidden();
  // Presenting, markdown would format text the blur is meant to hide.
  if (markdown && !hidden) return <ContentMarkdown text={text} className={cn("max-w-[76ch] wrap-anywhere", emphasis && "font-semibold")} />;
  return (
    <p className={cn(TEXT_CLASSES, emphasis && "font-semibold")}>
      <CallContentText text={text} />
    </p>
  );
}

function MonoBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-cap)] bg-card p-2 font-mono text-[0.8rem] leading-relaxed">
      <CallContentText text={text} />
    </pre>
  );
}

interface ContentBodyProps {
  slug: string;
  sessionId: string;
  content: SessionContent;
  // Prose (prompts, replies, instructions) reads as text; tool parts as code.
  prose: boolean;
  emphasis?: boolean;
}

export function ContentBody({ slug, sessionId, content, prose, emphasis }: ContentBodyProps) {
  const identity = JSON.stringify([content.id, content.sha256, content.render]);
  if (content.render === "text") return <TextContent key={identity} slug={slug} sessionId={sessionId} content={content} prose={prose} emphasis={emphasis} />;
  if (content.render === "image") return <ImageContent key={identity} slug={slug} sessionId={sessionId} content={content} />;
  if (content.render === "download") return <FileContent key={identity} slug={slug} sessionId={sessionId} content={content} />;
  return content.channel === "attachment" ? <MediaFacts content={content} /> : null;
}

function TextContent({ slug, sessionId, content, prose, emphasis }: ContentBodyProps) {
  const { t } = useTranslation();
  // Offsets of the body pages asked for; empty while only the preview shows.
  const [offsets, setOffsets] = useState<number[]>([]);
  const pages = useContentBodyPages(slug, sessionId, content, offsets);
  const loaded = pages.filter((page) => page.data).map((page) => page.data!);
  const failed = pages.find((page) => page.isError);
  const fetching = pages.some((page) => page.isFetching);
  // Offline, React Query holds the request until the browser reconnects.
  const waiting = pages.some((page) => page.fetchStatus === "paused");
  const last = loaded.at(-1);
  const markdown = prose && content.media_type === "text/markdown";
  const expandable = !content.preview || content.preview.truncated;
  const size = content.byte_count ?? 0;

  const text = loaded.length ? loaded.map((page) => page.text).join("") : (content.preview?.text ?? "");
  const block = text ? markdown || prose ? <TextBlock text={text} markdown={markdown} emphasis={emphasis} /> : <MonoBlock text={text} /> : null;

  return (
    <div className="grid gap-1.5">
      {block}
      {failed ? <FailureNote error={failed.error} onRetry={() => void failed.refetch()} /> : null}
      {expandable ? (
        <div className="flex flex-wrap items-center gap-2">
          {offsets.length === 0 ? (
            <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" onClick={() => setOffsets([0])}>
              {content.preview ? t("sessions.contents.body.showAll", { size: formatBytes(size) }) : t("sessions.contents.body.show")}
            </Button>
          ) : (
            <>
              {fetching || waiting ? (
                <span role="status" className="text-[0.8rem] text-muted-foreground">
                  {waiting ? t("sessions.contents.body.offline") : t("sessions.contents.body.loading")}
                </span>
              ) : null}
              {/* Only past a full run of pages: a failed page is retried, never requested twice. */}
              {last?.next_offset != null && loaded.length === offsets.length && !fetching ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-sm:min-h-[44px]"
                  onClick={() => setOffsets((current) => (current.includes(last.next_offset!) ? current : [...current, last.next_offset!]))}
                >
                  {t("sessions.contents.body.loadMore", { shown: formatBytes(last.next_offset), total: formatBytes(last.total_bytes) })}
                </Button>
              ) : null}
              {loaded.length ? (
                <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" onClick={() => setOffsets([])}>
                  {t("sessions.contents.body.showLess")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MediaFacts({ content }: { content: SessionContent }) {
  const { t } = useTranslation();
  const bytes = content.byte_count ?? content.original_byte_count;
  return (
    <p className="font-mono text-[0.8rem] text-muted-foreground">
      {bytes == null ? content.media_type : t("sessions.contents.media", { type: content.media_type, size: formatBytes(bytes) })}
    </p>
  );
}

// Object URLs pin their bytes until revoked; one per mounted image.
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

function ImageContent({ slug, sessionId, content }: Omit<ContentBodyProps, "prose">) {
  const { t } = useTranslation();
  const hidden = usePromptsHidden();
  const [revealed, setRevealed] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const image = useContentImage(slug, sessionId, content, revealed);
  useEffect(() => { if (revealed) target.current?.focus({ preventScroll: true }); }, [revealed]);
  const url = useObjectUrl(image.data);
  return (
    <div ref={target} tabIndex={revealed ? -1 : undefined} role={revealed ? "region" : undefined} aria-label={revealed ? t("sessions.contents.image.alt", { size: formatBytes(content.byte_count ?? 0) }) : undefined} className="grid justify-items-start gap-1.5 rounded-[var(--radius-cap)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {!revealed ? <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={() => setRevealed(true)}>{t("sessions.contents.call.showImage")}</Button> : image.isError ? (
        <FailureNote error={image.error} onRetry={() => void image.refetch()} />
      ) : url ? (
        <img
          src={url}
          alt={t("sessions.contents.image.alt", { size: formatBytes(content.byte_count ?? 0) })}
          className={cn("max-h-80 max-w-full rounded-[var(--radius-cap)] border border-border object-contain", hidden && "blur-xl")}
        />
      ) : (
        <span aria-hidden className="block h-40 w-60 max-w-full rounded-[var(--radius-cap)] bg-[color:var(--color-surface-3)]" />
      )}
      <FileContent slug={slug} sessionId={sessionId} content={content} />
    </div>
  );
}

function FileContent({ slug, sessionId, content }: Omit<ContentBodyProps, "prose">) {
  const { t } = useTranslation();
  const download = useDownloadContent(slug, sessionId, content);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <MediaFacts content={content} />
        <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={() => download.mutate()} disabled={download.isPending}>
          <Download aria-hidden />
          {download.isPending ? t("sessions.contents.downloading") : t("sessions.contents.download")}
        </Button>
      </div>
      {download.isError ? <FailureNote error={download.error} onRetry={() => download.mutate()} /> : null}
    </div>
  );
}

export function CoverageNote({ item, showCaptured = false }: { item: SessionContent; showCaptured?: boolean }) {
  const { t } = useTranslation();
  if (item.coverage === "captured") return showCaptured ? <CoverageBadge coverage={item.coverage} /> : null;
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

export function CoverageBadge({ coverage }: { coverage: ContentCoverage }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center rounded-[var(--radius-cap)] border border-dashed border-muted-foreground/45 px-1.5 py-px text-[0.76rem] font-semibold text-muted-foreground">
      {t(`sessions.contents.coverage.${coverage}`)}
    </span>
  );
}
