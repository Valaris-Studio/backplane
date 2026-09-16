// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { Sidebar } from "../Sidebar";

describe("Sidebar accessibility", () => {
  it("mobile backdrop close button exposes an accessible name", () => {
    renderWithProviders(
      <Sidebar collapsed={false} isMobile mobileOpen onCloseMobile={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: /close sidebar/i }),
    ).toBeInTheDocument();
  });
});
