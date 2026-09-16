// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { localizeLifecycleKindDoc } from "../lifecycleKindCatalog";

describe("lifecycle kind catalog", () => {
  it("preserves backend copy for a future kind without catalog keys", () => {
    const backendDoc = {
      summary: "Future kind summary",
      when_to_use: "Use it after a future step.",
      gotcha: "Future kind gotcha",
    };
    const translate = vi.fn((key: string) => `translated:${key}`);

    expect(
      localizeLifecycleKindDoc("future_kind", backendDoc, translate),
    ).toEqual(backendDoc);
    expect(translate).not.toHaveBeenCalled();
  });
});
