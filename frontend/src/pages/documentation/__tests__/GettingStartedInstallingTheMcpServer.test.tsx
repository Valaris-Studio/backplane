// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

//
// Post IA split, this section is the single home of the MCP install +
// configuration content that previously lived on the Platform Settings page.

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";

// Force the reduced-motion path so gsap doesn't leave elements with opacity:0.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

import { GettingStartedInstallingTheMcpServer } from "@/pages/documentation/sections/getting-started-installing-the-mcp-server";

function renderSection() {
  return renderWithProviders(<GettingStartedInstallingTheMcpServer />);
}

describe("GettingStartedInstallingTheMcpServer — post settings-page split", () => {
  it("no longer points readers at the Platform Settings page", () => {
    const { container } = renderSection();
    expect(container.textContent).not.toMatch(/platform settings/i);
    expect(container.textContent).not.toMatch(/settings page/i);
  });

  it("carries the uvx and pip install commands as copyable code blocks", () => {
    renderSection();

    expect(
      screen.getAllByText(/uvx/, { selector: "code" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/pip install/, { selector: "code" }).length,
    ).toBeGreaterThan(0);
    // Install commands + config snippet each need a working copy button.
    expect(
      screen.getAllByRole("button", { name: /copy code/i }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("leads with the published `uvx backplane-mcp` install command", () => {
    const { container } = renderSection();
    // The README's documented, owner-verified install — matches the exported
    // runner/MCP config templates. The git-URL form is a secondary variant.
    expect(container.textContent).toMatch(/uvx backplane-mcp/);
  });

  it("keeps the git-install form as a pin-to-revision / run-from-source variant", () => {
    const { container } = renderSection();
    expect(container.textContent).toMatch(/pin/i);
    expect(container.textContent).toMatch(/@<commit>#subdirectory=mcp-server/);
  });

  it("keeps the mcpServers config block and explains both env vars", () => {
    const { container } = renderSection();

    expect(
      screen.getByText(/"mcpServers"/, { selector: "code" }),
    ).toBeInTheDocument();
    expect(container.textContent).toMatch(/VALARIS_API_URL/);
    expect(container.textContent).toMatch(/VALARIS_API_KEY/);
    // The env-var explanations the settings-page tooltips carried.
    expect(container.textContent).toMatch(/Authorization: Bearer/);
    expect(container.textContent).toMatch(/origin without a trailing \/api/i);
  });

  it("sends readers to the account menu for their API key", () => {
    const { container } = renderSection();
    expect(container.textContent).toMatch(/account menu/i);
  });

  it("carries the current agent-workflow prompt overview", () => {
    const { container } = renderSection();
    expect(container.textContent).toMatch(/standup/);
    expect(container.textContent).toMatch(/plan[-_]work/);
    expect(container.textContent).toMatch(/decompose_card/);
    expect(container.textContent).toMatch(/implement/);
  });

  it("uses the exact underscore prompt identifiers registered by the server", () => {
    const { container } = renderSection();
    for (const prompt of [
      "init_project",
      "standup",
      "triage",
      "status",
      "plan_work",
      "decompose_card",
      "sprint",
      "pickup",
      "implement",
      "ship",
    ]) {
      expect(container.textContent).toContain(prompt);
    }
    expect(container.textContent).not.toMatch(/plan-work|init-project/);
  });

  it("configures VALARIS_API_URL as an origin rather than an /api base", () => {
    const { container } = renderSection();
    expect(container.textContent).toContain(
      '"VALARIS_API_URL": "https://your-backplane-host"',
    );
    expect(container.textContent).not.toContain("your-backplane-host/api");
  });
});
