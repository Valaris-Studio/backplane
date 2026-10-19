// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode, Suspense, useCallback, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { InitialCatalog } from "@/components/shared/InitialCatalog";
import { PageErrorBoundary, RouteErrorBoundary } from "@/components/shared/PageErrorBoundary";
import { App } from "./App";
import { ThemedToaster } from "@/components/ThemedToaster";
import { ThemeProvider } from "@/hooks/use-theme";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import type { CurrentUser } from "@/features/notifications/api/use-current-user";
import { meKeys } from "@/lib/query-keys";
import { isApiError } from "@/lib/api-error";
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

function NavigationProviders() {
  // Observe the existing authentication query; navigation never fetches a
  // second profile merely to retain a view.
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const readOwner = useCallback(() => {
    const me = client.getQueryState<CurrentUser>(meKeys.me());
    const accessLost = isApiError(me?.error) && [401, 403, 404].includes(me.error.status);
    return accessLost ? null : me?.data?.id ?? null;
  }, [client]);
  const ownerId = useSyncExternalStore(subscribe, readOwner, readOwner);
  return <NavigationGuardProvider>
    <ReturnNavigationProvider ownerId={ownerId}>
      <HandoffDraftProvider ownerId={ownerId}>
        {/* Page recovery must preserve retained handoffs and their retry identities. */}
        <RouteErrorBoundary>
          <App />
        </RouteErrorBoundary>
        <ThemedToaster />
      </HandoffDraftProvider>
    </ReturnNavigationProvider>
  </NavigationGuardProvider>;
}

const router = createBrowserRouter([{
  path: "*",
  element: (
    <RouteErrorBoundary>
      <WebSocketProvider>
        <NavigationProviders />
      </WebSocketProvider>
    </RouteErrorBoundary>
  ),
}]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PageErrorBoundary>
      <Suspense fallback={null}>
        <InitialCatalog ready={initialCatalogReady}>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <RouterProvider router={router} />
            </ThemeProvider>
          </QueryClientProvider>
        </InitialCatalog>
      </Suspense>
    </PageErrorBoundary>
  </StrictMode>,
);
