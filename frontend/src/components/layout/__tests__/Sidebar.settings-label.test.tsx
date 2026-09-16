// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { Sidebar } from "../Sidebar";

describe("Sidebar — settings entry after the IA split", () => {
  it('labels the settings link "Workspace Settings", not "Platform Settings"', () => {
    renderWithProviders(
      <Sidebar
        collapsed={false}
        isMobile={false}
        mobileOpen={false}
        onCloseMobile={() => {}}
      />,
    );

    const link = screen.getByRole("link", { name: /workspace settings/i });
    expect(link).toHaveAttribute(
      "href",
      expect.stringMatching(/\/settings$/),
    );
    expect(
      screen.queryByRole("link", { name: /platform settings/i }),
    ).not.toBeInTheDocument();
  });
});
