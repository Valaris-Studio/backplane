// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactElement, type ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, type MemoryRouterProps } from "react-router-dom";
import { ThemeProvider } from "@/hooks/use-theme";
import "@/i18n/config";

interface WrapperOptions {
  routerProps?: MemoryRouterProps;
  queryClient?: QueryClient;
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function createWrapper({ routerProps, queryClient }: WrapperOptions = {}) {
  const client = queryClient ?? createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter {...routerProps}>{children}</MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    );
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & WrapperOptions,
) {
  const { routerProps, queryClient, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createWrapper({ routerProps, queryClient }),
    ...renderOptions,
  });
}

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Force `prefers-reduced-motion` on or off for a test.
 *
 * The global stub in test/setup.ts answers `matches: false` to every query, so
 * components take their animated branch by default. Opt into the reduced-motion
 * branch when a suite needs GSAP's settled end-state synchronously rather than
 * asserting mid-tween — exit animations in particular gate unmount on a timeline
 * `onComplete` that jsdom's ticker makes unreliable to await.
 *
 * Pair with `afterEach(() => stubReducedMotion(false))`: a leaked `true` changes
 * the branch unrelated suites exercise.
 */
export function stubReducedMotion(reduceMatches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === REDUCE_QUERY ? reduceMatches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

export { createTestQueryClient };
export { screen, waitFor, within, act } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
