// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cardKeys } from "@/lib/query-keys";
import type { CardDependenciesView } from "@/types/kanban";

interface DependencyHighlightValue {
  /** Card ids to visually highlight — the hovered card plus everything it links to. */
  highlightedIds: ReadonlySet<string>;
  /**
   * Signal that `cardId` is hovered. Resolves the card's bidirectional links
   * (cached per card by React Query) and highlights them. Pass null on leave.
   * No-op when the card has no dependencies — avoids needless round trips.
   */
  setHoveredCard: (cardId: string | null, hasDependencies: boolean) => void;
}

const DependencyHighlightContext = createContext<DependencyHighlightValue>({
  highlightedIds: new Set(),
  setHoveredCard: () => {},
});

export function DependencyHighlightProvider({
  slug,
  boardId,
  children,
}: {
  slug: string;
  boardId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(new Set());
  // Guards against a stale fetch resolving after the pointer has moved on.
  const activeCardRef = useRef<string | null>(null);

  const setHoveredCard = useCallback(
    (cardId: string | null, hasDependencies: boolean) => {
      activeCardRef.current = cardId;

      if (!cardId || !hasDependencies) {
        setHighlightedIds((prev) => (prev.size ? new Set() : prev));
        return;
      }

      const queryKey = cardKeys.dependencies(slug, boardId, cardId);
      queryClient
        .fetchQuery({
          queryKey,
          queryFn: async () => {
            const { data } = await api.get<CardDependenciesView>(
              `/workspaces/${slug}/boards/${boardId}/cards/${cardId}/dependencies`,
            );
            return data;
          },
          staleTime: 30_000,
        })
        .then((view) => {
          // Pointer may have left this card before the fetch resolved.
          if (activeCardRef.current !== cardId) return;
          const next = new Set<string>([cardId]);
          for (const dep of view.depends_on) next.add(dep.depends_on_card_id);
          for (const dep of view.blocks) next.add(dep.card_id);
          setHighlightedIds(next);
        })
        .catch(() => {
          /* hover affordance only — a failed fetch silently highlights nothing */
        });
    },
    [queryClient, slug, boardId],
  );

  const value = useMemo<DependencyHighlightValue>(
    () => ({ highlightedIds, setHoveredCard }),
    [highlightedIds, setHoveredCard],
  );

  return (
    <DependencyHighlightContext.Provider value={value}>
      {children}
    </DependencyHighlightContext.Provider>
  );
}

export function useDependencyHighlight() {
  return useContext(DependencyHighlightContext);
}
