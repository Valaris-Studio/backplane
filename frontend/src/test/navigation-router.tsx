// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach } from "vitest";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import { createTestQueryClient } from "@/test/test-utils";

const routers = new Set<ReturnType<typeof createMemoryRouter>>();
afterEach(() => { for (const router of routers) router.dispose(); routers.clear(); });

function layout() {
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId="user-me"><HandoffDraftProvider ownerId="user-me"><Outlet /></HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>;
}
function renderRouter(router: ReturnType<typeof createMemoryRouter>) {
  routers.add(router);
  const client = createTestQueryClient();
  const rendered = render(
    <QueryClientProvider client={client}>
      <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, router, client };
}
export function renderNavigationRouter(
  routes: Parameters<typeof createMemoryRouter>[0],
  options: Parameters<typeof createMemoryRouter>[1] = {},
) {
  return renderRouter(createMemoryRouter([{ element: layout(), children: routes }], options));
}
export function renderBrowserNavigationRouter(routes: Parameters<typeof createBrowserRouter>[0], initialPath: string) {
  // Use the router's actual browser history idx, not a fake memory-router idx.
  window.history.replaceState({ idx: 0, key: "origin", usr: null }, "", initialPath);
  return renderRouter(createBrowserRouter([{ element: layout(), children: routes }]));
}
