// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useBoardDependencyValidation } from "../use-dependencies";
import { boardKeys } from "@/lib/query-keys";
import type { BoardDependencyValidation } from "@/types/kanban";

const SLUG = "acme";
const BOARD_ID = "board-1";

const okReport: BoardDependencyValidation = {
  ok: true,
  cycles: [],
  conflicts: [],
  orphans: [],
};

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe("useBoardDependencyValidation", () => {
  it("fetches the validation endpoint and returns the parsed report", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/dependencies/validation`,
        () => HttpResponse.json(okReport),
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useBoardDependencyValidation(SLUG, BOARD_ID),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);
  });

  it("uses the dependencyValidation query key", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/dependencies/validation`,
        () => HttpResponse.json(okReport),
      ),
    );
    const { client, Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useBoardDependencyValidation(SLUG, BOARD_ID),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = client.getQueryData(
      boardKeys.dependencyValidation(SLUG, BOARD_ID),
    );
    expect(cached).toEqual(okReport);
  });

  it("does not fetch when disabled", async () => {
    let called = false;
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/dependencies/validation`,
        () => {
          called = true;
          return HttpResponse.json(okReport);
        },
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useBoardDependencyValidation(SLUG, BOARD_ID, false),
      { wrapper: Wrapper },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(called).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
  });
});
