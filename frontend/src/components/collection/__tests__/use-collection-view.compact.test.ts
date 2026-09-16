// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCollectionView } from "../use-collection-view";

interface Item {
  id: string;
  title: string;
}

const items: Item[] = [
  { id: "1", title: "Alpha" },
  { id: "2", title: "Beta" },
];

const baseConfig = {
  items,
  searchFields: (item: Item) => [item.title],
  sorters: [
    { id: "title", label: "Title", compare: (a: Item, b: Item) => a.title.localeCompare(b.title) },
  ],
  persistenceKey: null as string | null,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("useCollectionView — compact view mode", () => {
  it("accepts compact as a view mode", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => result.current.setViewMode("compact"));
    expect(result.current.viewMode).toBe("compact");
  });

  it("persists compact across mounts", () => {
    const config = { ...baseConfig, persistenceKey: "compact-coll" };
    const { result, unmount } = renderHook(() => useCollectionView(config));
    act(() => result.current.setViewMode("compact"));
    unmount();

    const { result: remounted } = renderHook(() => useCollectionView(config));
    expect(remounted.current.viewMode).toBe("compact");
  });
});
