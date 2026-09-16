// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import type { WebSocketEvent } from "@/lib/websocket";
import { useWebSocketContext } from "@/providers/WebSocketProvider";

export function useWebSocket() {
  const ctx = useWebSocketContext();
  if (!ctx) {
    return {
      status: "disconnected" as const,
      subscribe: () => () => {},
    };
  }
  return ctx;
}

export function useWebSocketEvent(
  eventPattern: string,
  callback: (event: WebSocketEvent) => void,
) {
  const { subscribe } = useWebSocket();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return subscribe(eventPattern, (evt) => callbackRef.current(evt));
  }, [eventPattern, subscribe]);
}
