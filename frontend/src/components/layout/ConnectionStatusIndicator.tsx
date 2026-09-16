// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useWebSocket } from "@/hooks/use-websocket";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { cn } from "@/lib/utils";

type VisualState = "connected" | "connecting" | "disconnected";

function toVisualState(status: string): VisualState {
  if (status === "connected") return "connected";
  if (status === "disconnected") return "disconnected";
  return "connecting";
}

const DOT_CLASSES: Record<VisualState, string> = {
  connected: "bg-green-500",
  connecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

export function ConnectionStatusIndicator() {
  const { t } = useTranslation();
  const { status } = useWebSocket();
  const visual = toVisualState(status);
  const label = t(`ui.connection.status.${visual}`);

  return (
    <RichTooltip
      i18nKey={`chrome.connectionStatus.${visual}`}
      side="bottom"
    >
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          data-testid="connection-status-dot"
          data-status={visual}
          className={cn("h-2 w-2 rounded-full", DOT_CLASSES[visual])}
        />
      </button>
    </RichTooltip>
  );
}
