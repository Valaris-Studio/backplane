// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AgentInfoSection,
  AgentInfoSubtab,
} from "../agent-info-section";

// Isolate from the real i18n resources — the parallel subagent adding the keys
// may not have landed yet; we care about behavior, not translation wiring.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const table: Record<string, string> = {
        "agentic.section.title": "Agent info",
        "agentic.section.icon_alt": "Agent-owned information",
      };
      return table[key] ?? key;
    },
  }),
}));

describe("AgentInfoSection", () => {
  it("is collapsed by default: children present but hidden, aria-expanded=false", () => {
    render(
      <AgentInfoSection>
        <p>hidden-child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent info/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Content is in the DOM (for SR discoverability) but hidden via `hidden`.
    const child = screen.getByText("hidden-child");
    expect(child).toBeInTheDocument();
    // The content region (parent of the child) should carry `hidden`.
    const region = child.closest("[hidden]");
    expect(region).not.toBeNull();
  });

  it("renders children visibly when defaultCollapsed=false", () => {
    render(
      <AgentInfoSection defaultCollapsed={false}>
        <p>visible-child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent info/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const child = screen.getByText("visible-child");
    expect(child.closest("[hidden]")).toBeNull();
  });

  it("toggles collapsed state on click", async () => {
    const user = userEvent.setup();
    render(
      <AgentInfoSection>
        <p>child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent info/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("child").closest("[hidden]")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("child").closest("[hidden]")).not.toBeNull();
  });

  it("toggles with Enter when header button is focused", async () => {
    const user = userEvent.setup();
    render(
      <AgentInfoSection>
        <p>child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent info/i });
    toggle.focus();
    expect(toggle).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("toggles with Space when header button is focused", async () => {
    const user = userEvent.setup();
    render(
      <AgentInfoSection>
        <p>child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent info/i });
    toggle.focus();

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a custom title when provided instead of the default i18n key", () => {
    render(
      <AgentInfoSection title="Agent state">
        <p>child</p>
      </AgentInfoSection>,
    );

    const toggle = screen.getByRole("button", { name: /agent state/i });
    expect(toggle).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^agent info$/i }),
    ).not.toBeInTheDocument();
  });
});

describe("AgentInfoSubtab", () => {
  it("always renders children (no toggle)", () => {
    render(
      <AgentInfoSubtab>
        <p>subtab-child</p>
      </AgentInfoSubtab>,
    );

    const child = screen.getByText("subtab-child");
    expect(child).toBeInTheDocument();
    expect(child.closest("[hidden]")).toBeNull();

    // No collapse affordance.
    expect(
      screen.queryByRole("button", { name: /agent info/i }),
    ).not.toBeInTheDocument();
  });

  it("renders header with default title and the icon alt text", () => {
    const { container } = render(
      <AgentInfoSubtab>
        <p>x</p>
      </AgentInfoSubtab>,
    );

    const header = container.querySelector('[data-slot="agent-info-header"]');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText(/agent info/i)).toBeInTheDocument();
    // Icon has an accessible name from the i18n alt key.
    expect(
      within(header as HTMLElement).getByLabelText(/agent-owned information/i),
    ).toBeInTheDocument();
  });

  it("renders a custom title when provided", () => {
    render(
      <AgentInfoSubtab title="PR state">
        <p>x</p>
      </AgentInfoSubtab>,
    );

    expect(screen.getByText("PR state")).toBeInTheDocument();
  });
});
