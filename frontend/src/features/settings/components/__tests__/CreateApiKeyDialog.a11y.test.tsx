// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import userEvent from "@testing-library/user-event";
import { CreateApiKeyDialog } from "../CreateApiKeyDialog";

describe("CreateApiKeyDialog accessibility", () => {
  it("exposes an accessible name on the copy button after key creation", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/me/api-keys", () =>
        HttpResponse.json({
          id: "key-new",
          name: "new",
          key_prefix: "val_zzzz",
          created_at: "2026-04-18T00:00:00Z",
          raw_key: "val_zzzz_full_secret",
        }),
      ),
    );

    renderWithProviders(<CreateApiKeyDialog open onOpenChange={() => {}} />);

    const nameInput = screen.getByPlaceholderText(/claude desktop/i);
    await user.type(nameInput, "new-key");
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copy api key/i }),
      ).toBeInTheDocument();
    });
  });
});
