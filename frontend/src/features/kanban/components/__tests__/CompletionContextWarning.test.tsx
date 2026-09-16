// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { CompletionContextWarning } from "../CompletionContextWarning";

describe("completion edit context warning", () => {
  it("identifies the active role and explains retry without preventing editing", async () => {
    server.use(http.get("/api/workspaces/acme/config/completion-context-impact", () => HttpResponse.json({
      attempts: [{ attempt_id: "attempt-1", execution_id: "execution-1", board_id: "board-1", kind: "review", role: "independent-arbiter", binding_known: true }],
    })));
    renderWithProviders(<CompletionContextWarning slug="acme" sourceKind="note" sourceId="note-1" />);
    expect(await screen.findByText(/independent-arbiter/)).toBeInTheDocument();
    expect(screen.getByText(/saving.*invalidate/i)).toBeInTheDocument();
    expect(screen.getByText(/retry/i)).toBeInTheDocument();
  });
});
