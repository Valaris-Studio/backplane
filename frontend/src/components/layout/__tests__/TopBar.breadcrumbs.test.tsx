// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import i18n from "@/i18n/config";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

function renderAt(pathname: string) {
  return renderWithProviders(
    <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    { routerProps: { initialEntries: [pathname] } },
  );
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("TopBar breadcrumbs — known route segments are localized", () => {
  it("renders the runner overview crumb from i18n in English", () => {
    renderAt("/acme/runner/overview");
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
  });

  it("renders the runner overview crumb in Spanish, matching the tab label", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/runner/overview");

    expect(screen.getByRole("link", { name: "Resumen" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
  });

  it("localizes the other runner tab segments in Spanish", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/runner/pipeline");

    expect(screen.getByRole("link", { name: "Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runners" })).toBeInTheDocument();
  });

  it("localizes workspace-level route segments in Spanish", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/approvals");

    expect(screen.getByRole("link", { name: "Aprobaciones" })).toBeInTheDocument();
  });

  it("leaves unknown segments as humanized path text", () => {
    renderAt("/acme/some-unmapped-segment");
    expect(
      screen.getByRole("link", { name: "some unmapped segment" }),
    ).toBeInTheDocument();
  });

  it("does not translate opaque id segments, only the known ones around them", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/runner/executions/7f3c1a90-0000-4000-8000-000000000001");

    // "executions" is deliberately absent from the map (no nav/tab vocabulary
    // covers it), so it stays humanized path text alongside the raw id.
    expect(screen.getByRole("link", { name: "Runners" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "executions" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /7f3c1a90/ }),
    ).toBeInTheDocument();
  });
});
