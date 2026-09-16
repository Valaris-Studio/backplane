// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { FileText, LayoutGrid } from "lucide-react";
import { renderWithProviders } from "@/test/test-utils";
import { TabNav } from "@/components/layout/TabNav";

const tabs = [
  { label: "Kanban", path: "kanban", icon: LayoutGrid },
  { label: "Notes", path: "notes", icon: FileText },
];

function renderTabNav() {
  return renderWithProviders(
    <TabNav tabs={tabs} basePath="/acme/boards/b1" />,
    { routerProps: { initialEntries: ["/acme/boards/b1/kanban"] } },
  );
}

describe("TabNav active indicator", () => {
  it("paints the slider with the primary token instead of a raw hex", () => {
    const { container } = renderTabNav();
    const indicator = container.querySelector("div.absolute.z-0");
    expect(indicator).not.toBeNull();
    expect(indicator!.className).not.toMatch(/#6aff00/i);
    expect(indicator!.className).toContain("var(--color-primary)");
  });

  it("disables the slide transition under reduced motion", () => {
    const { container } = renderTabNav();
    const indicator = container.querySelector("div.absolute.z-0");
    expect(indicator!.className).toContain("motion-reduce:transition-none");
  });
});
