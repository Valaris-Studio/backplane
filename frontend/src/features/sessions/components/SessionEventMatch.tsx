// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api-error";
import { useSessionCall } from "../api/use-sessions";
import { useSessionReaderActive } from "../api/use-session-contents";
import type { FindDestination } from "../hooks/use-find-navigation";
import { eventField } from "../utils/find-ranges";
import { SessionMatchText } from "./SessionMatchText";
import { CallContentText } from "./PromptText";

export function SessionEventMatch({ slug, sessionId, destination }: { slug: string; sessionId: string; destination: FindDestination }) {
  const { t } = useTranslation();
  const id = useId();
  const active = useSessionReaderActive();
  const target = useRef<HTMLDivElement>(null);
  const hit = destination.hit;
  const call = useSessionCall(slug, sessionId, hit.call_key ?? "", active && !!hit.call_key && hit.source_state === "available");
  const event = call.data?.events.find((event) => event.id === hit.source_id && (!hit.event_id || event.event_id === hit.event_id));
  const text = event ? eventField(event.data, hit.field) : null;
  const unavailable = hit.source_state !== "available" || (isApiError(call.error) && [404, 410].includes(call.error.status)) || (call.isSuccess && text === null);
  useEffect(() => {
    if (active && (text !== null || unavailable)) (target.current?.querySelector("mark") ?? target.current)?.scrollIntoView?.({ block: "nearest" });
  }, [active, text, unavailable, destination.request]);
  return <section aria-labelledby={id} className="grid min-w-0 gap-3 rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-1)] p-[var(--card-padding)]">
    <h2 id={id} className="text-base font-bold">{t("sessions.find.match")}</h2>
    <p className="wrap-anywhere font-mono text-xs text-muted-foreground"><CallContentText text={hit.field} /></p>
    <div ref={target} className="scroll-mt-[calc(var(--topbar-height)+1rem)]">
      {unavailable ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.find.sourceUnavailable")}</p>
        : call.isError ? <div className="grid justify-items-start gap-2"><p role="status" className="text-sm text-muted-foreground">{t("sessions.contents.loadError")}</p>
          <Button variant="outline" className="min-h-[44px] min-w-[44px]" onClick={() => void call.refetch()}>{t("sessions.contents.retry")}</Button></div>
          : text !== null ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[var(--radius-cap)] bg-card p-3 font-mono text-sm"><SessionMatchText text={text} range={{ byteStart: hit.byte_start, byteEnd: hit.byte_end, offset: 0 }} /></pre>
            : <p role="status" className="text-sm text-muted-foreground">{t("sessions.contents.body.loading")}</p>}
    </div>
  </section>;
}
