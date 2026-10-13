// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  WebSocketService,
  type ConnectionStatus,
  type WebSocketEvent,
} from "@/lib/websocket";

interface WebSocketContextValue {
  status: ConnectionStatus;
  subscribe: (
    eventPattern: string,
    handler: (event: WebSocketEvent) => void,
  ) => () => void;
  /**
   * Patterns the server refused on the current connection. "connected" alone
   * does not mean every subscription is live. Optional so test doubles of
   * this context may omit it (read as "nothing denied").
   */
  deniedPatterns?: ReadonlySet<string>;
}

const NO_DENIED_PATTERNS: ReadonlySet<string> = new Set();

// Exported so tests can supply a controllable `subscribe` without the real
// provider, which opens an actual socket on mount. App code should use
// WebSocketProvider, not this.
export const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// Top-level app routes that shadow the /:slug workspace pattern (App.tsx).
// Without this, a fresh instance sitting on /setup opened a socket to
// /ws/workspaces/setup/events and greeted every self-hoster with 403 log noise.
const NON_WORKSPACE_ROUTES = new Set(["login", "setup", "documentation"]);

function extractWorkspaceSlug(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  // Route pattern: /:slug/... -- first segment is the workspace slug
  if (parts.length === 0) return null;
  const first = parts[0] ?? null;
  return first && NON_WORKSPACE_ROUTES.has(first) ? null : first;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const slug = extractWorkspaceSlug(pathname);
  const serviceRef = useRef<WebSocketService | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [deniedPatterns, setDeniedPatterns] =
    useState<ReadonlySet<string>>(NO_DENIED_PATTERNS);
  // Bumped each time a new service is created so child effects re-subscribe.
  const [serviceEpoch, setServiceEpoch] = useState(0);

  useEffect(() => {
    if (!slug) return;

    const baseURL = import.meta.env.VITE_API_URL || window.location.origin;
    const service = new WebSocketService(baseURL, slug);
    serviceRef.current = service;
    setServiceEpoch((e) => e + 1);

    setDeniedPatterns(NO_DENIED_PATTERNS);
    const unsubStatus = service.onStatusChange((next) => {
      setStatus(next);
      // The server decides denials per connection, and every new connection
      // resends the full pattern set, so earlier refusals no longer apply.
      if (next === "connected") setDeniedPatterns(NO_DENIED_PATTERNS);
    });
    const unsubDenied = service.onSubscriptionDenied(({ patterns }) => {
      setDeniedPatterns((previous) =>
        patterns.every((pattern) => previous.has(pattern))
          ? previous
          : new Set([...previous, ...patterns]),
      );
    });
    service.connect();

    return () => {
      unsubStatus();
      unsubDenied();
      service.disconnect();
      serviceRef.current = null;
    };
  }, [slug]);

  const subscribe = useCallback(
    (
      pattern: string,
      handler: (event: WebSocketEvent) => void,
    ): (() => void) => {
      return serviceRef.current?.subscribe(pattern, handler) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serviceEpoch],
  );

  const value = useMemo<WebSocketContextValue>(
    () => ({ status, subscribe, deniedPatterns }),
    [status, subscribe, deniedPatterns],
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocketContext() {
  return useContext(WebSocketContext);
}
