// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import type { SessionContent } from "@/types/agent-session";
import { useSessionContents } from "../api/use-session-contents";
import { formatClock } from "../utils/format";
import { ContentBody, CoverageNote } from "./ContentBody";

interface SessionCallContentProps {
  slug: string;
  sessionId: string;
  callId: string;
}

export function SessionCallContent({ slug, sessionId, callId }: SessionCallContentProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <div className="min-w-0 border-t border-border pt-2">
    <Button
      variant="ghost"
      size="sm"
      className="max-w-full whitespace-normal text-left max-sm:min-h-[44px]"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((current) => !current)}
    >
      <ChevronRight aria-hidden className={cn("shrink-0 transition-transform duration-150", open && "rotate-90")} />
      {t("sessions.contents.call.inspect")}
    </Button>
    {open ? <CapturedCallRecords id={panelId} slug={slug} sessionId={sessionId} callId={callId} /> : null}
  </div>;
}

function CapturedCallRecords({ id, slug, sessionId, callId }: SessionCallContentProps & { id: string }) {
  const { t } = useTranslation();
  const [showNative, setShowNative] = useState(false);
  const contents = useSessionContents(slug, sessionId, callId);
  const headingId = `${id}-heading`;
  const items = contents.data?.pages.flatMap((page) => page.items) ?? [];
  const nativeCount = items.filter((item) => item.channel === "native_record").length;
  const visible = showNative ? items : items.filter((item) => item.channel !== "native_record");
  const status = isApiError(contents.error) ? contents.error.status : null;
  const refused = status === 401 || status === 403;
  const unavailable = status === 404 || status === 410;

  return <section id={id} aria-labelledby={headingId} className="min-w-0 pt-3">
    <h3 id={headingId} className="text-sm font-semibold">{t("sessions.contents.call.title")}</h3>
    {contents.isPending ? (
      <p role="status" className="py-3 text-sm text-muted-foreground">{t("sessions.contents.call.loading")}</p>
    ) : contents.isError ? (
      <div className="grid justify-items-start gap-2 py-3 text-sm text-muted-foreground">
        <p role="status">{t(refused ? "sessions.contents.refused" : unavailable ? "sessions.contents.call.unavailable" : "sessions.contents.call.loadError")}</p>
        {!refused && !unavailable ? <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={() => void contents.refetch()}>
          <RotateCw aria-hidden />
          {t("sessions.contents.retry")}
        </Button> : null}
      </div>
    ) : (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm text-muted-foreground">
          <p>{t("sessions.contents.call.loaded", { count: items.length })}</p>
          {nativeCount > 0 ? <>
            {!showNative ? <p>{t("sessions.contents.call.nativeHidden", { count: nativeCount })}</p> : null}
            <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" aria-pressed={showNative} onClick={() => setShowNative((current) => !current)}>
              {t(showNative ? "sessions.contents.call.hideNative" : "sessions.contents.call.showNative")}
            </Button>
          </> : null}
        </div>
        {!items.length && !contents.hasNextPage ? <p className="py-2 text-sm text-muted-foreground">{t("sessions.contents.call.empty")}</p> : null}
        {visible.length ? <ol aria-labelledby={headingId} className="min-w-0 divide-y divide-border">
          {visible.map((item) => <CapturedCallRecord key={JSON.stringify([item.id, item.sha256, item.render])} slug={slug} sessionId={sessionId} item={item} />)}
        </ol> : null}
        {contents.hasNextPage ? <Button
          variant="ghost"
          size="sm"
          className="mt-2 max-sm:min-h-[44px]"
          disabled={contents.isFetching}
          onClick={() => void contents.fetchNextPage({ cancelRefetch: false })}
        >
          {t(contents.isFetchingNextPage ? "sessions.contents.loadingMore" : "sessions.contents.loadMore")}
        </Button> : null}
      </>
    )}
  </section>;
}

function CapturedCallRecord({ slug, sessionId, item }: { slug: string; sessionId: string; item: SessionContent }) {
  const { t } = useTranslation();
  const labelId = useId();
  const label = t(item.channel === "prompt" ? "sessions.contents.labels.you" : item.channel === "reply" ? "sessions.contents.labels.agent" : [`sessions.contents.labels.${item.channel}`, `sessions.contents.parts.${item.channel}`]);
  return <li aria-labelledby={labelId} className="grid min-w-0 gap-2 py-3">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h4 id={labelId} className="text-sm font-semibold">{label}</h4>
      {item.display_path ? <span className="min-w-0 wrap-anywhere font-mono text-sm">{item.display_path}</span> : null}
      <span className="text-sm text-muted-foreground">{t("sessions.contents.source.reference", { source: t(`sessions.contents.source.${item.source.kind}`), order: item.source.order })}</span>
      <time dateTime={item.occurred_at} className="ml-auto text-sm tabular-nums text-muted-foreground">{formatClock(item.occurred_at)}</time>
    </div>
    <div className="justify-self-start"><CoverageNote item={item} showCaptured /></div>
    <ContentBody slug={slug} sessionId={sessionId} content={item} prose={false} />
  </li>;
}
