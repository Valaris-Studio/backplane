// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WebSocketEvent } from "@/lib/websocket";
import { formatRelative } from "@/lib/date-format";
import {
  busNamespaceOf,
  namespaceOf,
  type ObserverNamespace,
} from "../hooks/useObserverEvents";
import { summarizePayload } from "../utils/summarizePayload";

interface ObserverEventRowProps {
  event: WebSocketEvent;
  /** Re-render tick so the live feed's relative timestamps stay current. */
  now: number;
}

const NAMESPACE_VARIANT: Record<
  ObserverNamespace,
  "default" | "secondary" | "outline" | "info"
> = {
  card: "secondary",
  agent: "default",
  execution: "info",
  approval: "outline",
};

export function ObserverEventRow({ event, now }: ObserverEventRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ns = namespaceOf(event.event);
  const variant = ns ? NAMESPACE_VARIANT[ns] : "outline";
  const summary = summarizePayload(event.payload);
  // `now` is a render-tick: when the panel advances it, this row recomputes its
  // relative timestamp against the current clock. Read once so intent is clear.
  void now;

  return (
    <li className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <div className="flex items-center gap-2">
          {/* Known namespaces get their translated label; anything else is
              badged with the raw first dot-segment as the bus emitted it, since
              the panel now buffers namespaces nobody enumerated in advance. */}
          {ns ? (
            <Badge variant={variant} className="px-1.5 py-0 text-[0.6rem]">
              {t(`observer.namespaces.${ns}`)}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="px-1.5 py-0 font-mono text-[0.6rem]"
            >
              {busNamespaceOf(event.event)}
            </Badge>
          )}
          <span className="truncate font-mono text-xs text-foreground">
            {event.event}
          </span>
          {/* The bus event_id is what you paste into a log query or a bug
              report — it is the only stable handle on a single event. */}
          <span className="ml-auto shrink-0 font-mono text-[0.6rem] text-muted-foreground">
            {event.event_id}
          </span>
          <span className="shrink-0 text-[0.65rem] text-muted-foreground">
            {formatRelative(event.timestamp, { withSeconds: true })}
          </span>
        </div>
        {summary ? (
          <span className="truncate text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </button>
      {open ? (
        <pre className="max-h-48 overflow-auto bg-muted/30 px-3 py-2 text-[0.7rem] text-muted-foreground">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}
