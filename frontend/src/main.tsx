// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ThemedToaster } from "@/components/ThemedToaster";
import { ThemeProvider } from "@/hooks/use-theme";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { shouldRetry } from "@/lib/should-retry";
import { initialCatalogReady } from "./i18n/config";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetry,
      // WS events drive freshness for every domain that opts in via
      // useDomainSync; the window-focus refetch turns a benign tab-switch
      // into a fan-out storm against a backend that already publishes the
      // changes we'd be refetching for. 2026-04-25 smoke showed this path
      // contributing to the 429 storm on /executions.
      refetchOnWindowFocus: false,
    },
  },
});

// Hold the first render until the active locale's catalog is in memory —
// otherwise a non-English session paints English copy and swaps a tick later.
// Resolves immediately for English, whose catalog ships in the entry chunk.
void initialCatalogReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <WebSocketProvider>
              <App />
              <ThemedToaster />
            </WebSocketProvider>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
