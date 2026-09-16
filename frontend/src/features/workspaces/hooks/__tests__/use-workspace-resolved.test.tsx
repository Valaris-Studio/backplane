// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import {
  WorkspaceResolvedProvider,
  useResolvedWorkspaceSlug,
} from "../use-workspace-resolved";

// The chrome badges consume this to decide whether their slug is safe to query.
// The DEFAULT matters on its own: a consumer rendered outside the gate — a unit
// test, or a future route that forgets the provider — must fail CLOSED. A quiet
// badge is invisible; a badge querying an unverified slug is the 404 storm
// WorkspaceLayout exists to remove, and no page-level test can see it.
function SlugProbe() {
  const slug = useResolvedWorkspaceSlug("acme");
  return <span data-testid="probe">{slug ?? "none"}</span>;
}

describe("useResolvedWorkspaceSlug", () => {
  it("withholds the slug when no provider is above it", () => {
    renderWithProviders(<SlugProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
  });

  it("withholds the slug while the workspace is unresolved", () => {
    renderWithProviders(
      <WorkspaceResolvedProvider resolved={false}>
        <SlugProbe />
      </WorkspaceResolvedProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
  });

  it("releases the slug once the workspace has resolved", () => {
    renderWithProviders(
      <WorkspaceResolvedProvider resolved>
        <SlugProbe />
      </WorkspaceResolvedProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("acme");
  });
});
