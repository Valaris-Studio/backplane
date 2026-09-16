// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import { ToolPicker } from "../ToolPicker";

describe("ToolPicker — selected tool badge tooltips", () => {
  it("does not render a raw HTML title attribute on selected badges", () => {
    const { container } = renderWithProviders(
      <ToolPicker value={["Read"]} onChange={vi.fn()} />,
    );
    // No element with a title attribute that matches tool-badge text. The
    // The purge migration swapped the raw title for a RichTooltip.
    const titled = container.querySelectorAll("[title]");
    // Nothing in the ToolPicker subtree should carry a raw `title` after the
    // migration; the shadcn Select / Input internals don't emit title either.
    expect(titled).toHaveLength(0);
  });

  it("wraps each selected tool badge in a RichTooltip trigger", () => {
    renderWithProviders(<ToolPicker value={["Read"]} onChange={vi.fn()} />);
    // The tool label is rendered inside the selected-badge AND as a row in
    // the group list below. The badge's wrapping span uses the `font-mono`
    // class — grab that to disambiguate.
    const labels = screen.getAllByText("Read");
    const badgeLabel = labels.find((el) =>
      el.className.includes("font-mono") && el.closest("[role='button']"),
    );
    expect(badgeLabel).toBeTruthy();
    const trigger = badgeLabel?.closest("[role='button']");
    expect(trigger).not.toBeNull();
  });

  it("shows the catalog summary for a known tool on hover", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ToolPicker value={["Read"]} onChange={vi.fn()} />);
    const labels = screen.getAllByText("Read");
    const badgeLabel = labels.find((el) =>
      el.className.includes("font-mono") && el.closest("[role='button']"),
    );
    const trigger = badgeLabel?.closest("[role='button']");
    await user.hover(trigger as HTMLElement);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent?.length ?? 0).toBeGreaterThan(10);
  });

  it("opens the expanded panel with the toolBadge key summary when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ToolPicker value={["Read"]} onChange={vi.fn()} />);
    const labels = screen.getAllByText("Read");
    const badgeLabel = labels.find((el) =>
      el.className.includes("font-mono") && el.closest("[role='button']"),
    );
    const trigger = badgeLabel?.closest("[role='button']");
    await user.click(trigger as HTMLElement);
    const backdrop = await screen.findByTestId("rt-backdrop");
    // Header shows the known-tool summary override ("Read a file…"); the
    // body pulls examples from the toolBadge i18n key — assert one of those
    // so we know the RichTooltip is reading the right key.
    expect(backdrop).toHaveTextContent(/de-duplicates/i);
  });

  it("still renders a tooltip trigger for an unknown/custom tool id", () => {
    renderWithProviders(
      <ToolPicker value={["mcp__custom__tool"]} onChange={vi.fn()} />,
    );
    // Custom id doesn't appear in any group list, so only the badge renders
    // it. But the input placeholder contains the same text — scope to the
    // badge-labelled span with font-mono.
    const labels = screen.getAllByText("mcp__custom__tool");
    const badgeLabel = labels.find((el) => el.className.includes("font-mono"));
    const trigger = badgeLabel?.closest("[role='button']");
    expect(trigger).not.toBeNull();
  });
});

describe("ToolPicker — group tooltips preserved", () => {
  it("still exposes the claudeBuiltins group tooltip trigger", () => {
    renderWithProviders(<ToolPicker value={[]} onChange={vi.fn()} />);
    const groupHeader = screen.getByText(/claude code built-ins/i);
    const groupRow = groupHeader.closest("button");
    expect(groupRow).not.toBeNull();
    // The tooltip trigger is a sibling span inside the header button.
    const triggers = within(groupRow as HTMLElement).getAllByRole("button");
    // One button is the collapse toggle, plus the RichTooltip trigger span.
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });
});
