// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useCardDetail } from "../use-card-detail";
import type { Card } from "@/types/kanban";

const apiGet = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

const SLUG = "ws";
const BOARD_ID = "b1";
const CARD_ID = "card-1";

const summaryCard = {
  id: CARD_ID,
  title: "Card",
  description: "excerpt only...",
} as unknown as Card;

const fullCard = {
  id: CARD_ID,
  title: "Card",
  description: '{"type":"doc","content":[]}',
} as unknown as Card;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useCardDetail", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: fullCard });
  });

  it("re-reads the full card so the editor never opens on a summary excerpt", async () => {
    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, summaryCard, true),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.card?.description).toBe(fullCard.description),
    );
    expect(apiGet).toHaveBeenCalledWith(
      `/workspaces/${SLUG}/boards/${BOARD_ID}/cards/${CARD_ID}`,
    );
  });

  it("serves the board card while the full read is in flight — no flash-clear", () => {
    let resolve: (value: unknown) => void = () => {};
    apiGet.mockReturnValue(new Promise((r) => (resolve = r)));

    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, summaryCard, true),
      { wrapper },
    );

    // Existing content stays on screen; only the description is provisional.
    expect(result.current.card?.id).toBe(CARD_ID);
    expect(result.current.card?.description).toBe("excerpt only...");
    resolve({ data: fullCard });
  });

  it("does not fetch while the sheet is closed", () => {
    renderHook(() => useCardDetail(SLUG, BOARD_ID, summaryCard, false), {
      wrapper,
    });

    expect(apiGet).not.toHaveBeenCalled();
  });

  it("returns null when no card is selected", () => {
    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, null, true),
      { wrapper },
    );

    expect(result.current.card).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe("useCardDetail — placeholder is distinguishable from real detail", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: fullCard });
  });

  it("reports the card as not yet loaded while serving the board placeholder", () => {
    apiGet.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, summaryCard, true),
      { wrapper },
    );

    // Saving here would persist the 200-char excerpt over the real body.
    expect(result.current.isDetailLoaded).toBe(false);
    expect(result.current.card?.description).toBe("excerpt only...");
  });

  it("reports loaded once the full read lands", async () => {
    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, summaryCard, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isDetailLoaded).toBe(true));
    expect(result.current.card?.description).toBe(fullCard.description);
  });

  it("stays not-loaded when the detail read fails, so the excerpt is never saved back", async () => {
    apiGet.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useCardDetail(SLUG, BOARD_ID, summaryCard, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isDetailError).toBe(true));
    expect(result.current.isDetailLoaded).toBe(false);
    // The sheet still renders — only writes are withheld.
    expect(result.current.card?.id).toBe(CARD_ID);
  });
});
