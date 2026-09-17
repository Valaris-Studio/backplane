// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, useNavigate } from "react-router-dom";
import "@/i18n/config";
import type { Workspace } from "@/types/workspace";
import { WorkspaceCard } from "../WorkspaceCard";

vi.mock("@/features/visuals/components/WaveBackground", () => ({
  WaveBackground: () => null,
}));

function WorkspaceNavigation({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Persisted workspace",
    slug,
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  // Match WorkspacesPage's persisted-workspace callback, using real browser history.
  return <WorkspaceCard workspace={workspace} onOpen={(value) => navigate(`/${value}`)} />;
}

describe("persisted workspace browser navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each(["\\example.invalid", "\\\\example.invalid", "/\\example.invalid"])(
    "keeps a workspace slug %j on the current origin",
    async (slug) => {
      const origin = window.location.origin;
      render(<BrowserRouter><WorkspaceNavigation slug={slug} /></BrowserRouter>);

      await userEvent.click(screen.getByRole("button", { name: /persisted workspace/i }));

      await waitFor(() => expect(window.location.pathname).toBe("/example.invalid"));
      expect(window.location.origin).toBe(origin);
    },
  );

  it("preserves ordinary workspace navigation", async () => {
    render(<BrowserRouter><WorkspaceNavigation slug="acme-platform" /></BrowserRouter>);

    await userEvent.click(screen.getByRole("button", { name: /persisted workspace/i }));

    await waitFor(() => expect(window.location.pathname).toBe("/acme-platform"));
  });
});
