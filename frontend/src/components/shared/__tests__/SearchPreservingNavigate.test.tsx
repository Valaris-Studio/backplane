// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import { SearchPreservingNavigate } from "../SearchPreservingNavigate";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

describe("SearchPreservingNavigate", () => {
  it("redirects relative while keeping the query string", () => {
    renderWithProviders(
      <Routes>
        <Route path="/acme/boards/board-1">
          <Route index element={<SearchPreservingNavigate to="kanban" />} />
          <Route path="kanban" element={<LocationProbe />} />
        </Route>
      </Routes>,
      { routerProps: { initialEntries: ["/acme/boards/board-1?card=card-9"] } },
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/acme/boards/board-1/kanban?card=card-9",
    );
  });

  it("redirects cleanly when there is no query string", () => {
    renderWithProviders(
      <Routes>
        <Route path="/acme/boards/board-1">
          <Route index element={<SearchPreservingNavigate to="kanban" />} />
          <Route path="kanban" element={<LocationProbe />} />
        </Route>
      </Routes>,
      { routerProps: { initialEntries: ["/acme/boards/board-1"] } },
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      /\/acme\/boards\/board-1\/kanban$/,
    );
  });
});
