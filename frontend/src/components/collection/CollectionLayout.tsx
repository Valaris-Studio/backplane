// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { ViewMode } from "./use-collection-view";
import { cn } from "@/lib/utils";

interface CollectionLayoutProps<T> {
  items: T[];
  viewMode: ViewMode;
  getKey: (item: T) => string;
  renderGrid: (item: T) => ReactNode;
  renderList: (item: T) => ReactNode;
  gridClassName?: string;
  listClassName?: string;
  emptyState?: ReactNode;
}

const DEFAULT_GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";
const DEFAULT_LIST = "flex flex-col divide-y divide-border/60 rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/40 overflow-hidden";

export function CollectionLayout<T>({
  items,
  viewMode,
  getKey,
  renderGrid,
  renderList,
  gridClassName,
  listClassName,
  emptyState,
}: CollectionLayoutProps<T>) {
  if (!items.length) {
    return emptyState ? <>{emptyState}</> : null;
  }

  if (viewMode === "list") {
    return (
      <div className={cn(DEFAULT_LIST, listClassName)} role="list">
        {items.map((item) => (
          <div key={getKey(item)} role="listitem">
            {renderList(item)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn(DEFAULT_GRID, gridClassName)}>
      {items.map((item) => (
        // data-stagger-id lets a caller animate only the genuinely-new items
        // on a re-render instead of replaying the whole grid entrance.
        <div key={getKey(item)} data-stagger-item data-stagger-id={getKey(item)}>
          {renderGrid(item)}
        </div>
      ))}
    </div>
  );
}
