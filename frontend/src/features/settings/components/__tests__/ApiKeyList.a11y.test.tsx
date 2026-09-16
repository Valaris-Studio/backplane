// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ApiKeyList } from "../ApiKeyList";
import type { ApiKey } from "@/types/api-key";

const KEYS: ApiKey[] = [
  {
    id: "key-1",
    name: "Dev key",
    key_prefix: "val_abcd",
    created_at: "2026-04-01T00:00:00Z",
    last_used_at: null,
  },
];

describe("ApiKeyList accessibility", () => {
  it("exposes an accessible name on the delete button", async () => {
    server.use(http.get("/api/me/api-keys", () => HttpResponse.json(KEYS)));

    renderWithProviders(<ApiKeyList />);

    await waitFor(() => {
      expect(screen.getByText("Dev key")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /delete api key/i }),
    ).toBeInTheDocument();
  });
});
