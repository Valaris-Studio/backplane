// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { RoleCombobox } from "../RoleCombobox";

const SUGGESTIONS = ["orchestrator", "reviewer", "documentator"];

// Simulates the DialogContent scroll container every embedding surface puts
// around RoleCombobox (LaunchRunnerWizard, AddTeamMemberDialog, …). jsdom
// can't measure clipping, so the observable portal contract is DOM ancestry:
// the open listbox must NOT live inside this container.
function Harness({
  suggestions = SUGGESTIONS,
  initialRoles = [],
  onAdd,
  onRemove,
}: {
  suggestions?: string[];
  initialRoles?: string[];
  onAdd?: (role: string) => void;
  onRemove?: (role: string) => void;
}) {
  const [roles, setRoles] = useState<string[]>(initialRoles);
  return (
    <div
      data-testid="dialog-scroll"
      className="overflow-y-auto"
      style={{ overflowY: "auto", maxHeight: 200 }}
    >
      <RoleCombobox
        suggestions={suggestions}
        selectedRoles={roles}
        onAdd={(role) => {
          onAdd?.(role);
          setRoles((prev) => [...prev, role]);
        }}
        onRemove={(role) => {
          onRemove?.(role);
          setRoles((prev) => prev.filter((r) => r !== role));
        }}
      />
    </div>
  );
}

function mockInputRect(
  input: HTMLElement,
  rect: { left: number; top: number; bottom: number; width: number },
) {
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
}

// The fixed-position anchor may be the listbox itself or a wrapper it portals
// inside (MentionPicker wraps its <ul> in a positioned <div>).
function fixedAnchorOf(listbox: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = listbox;
  while (el && el !== document.body) {
    if (el.style.position === "fixed") return el;
    el = el.parentElement;
  }
  return null;
}

describe("RoleCombobox — portaled listbox (dialog clipping fix)", () => {
  it("renders the open listbox outside the scroll container, under document.body", async () => {
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);

    const listbox = await screen.findByRole("listbox");
    const scrollContainer = screen.getByTestId("dialog-scroll");

    expect(scrollContainer.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });

  it("positions the listbox fixed, anchored to the input rect, above the dialog overlay", async () => {
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    mockInputRect(input, { left: 40, top: 100, bottom: 132, width: 240 });
    await user.click(input);

    const listbox = await screen.findByRole("listbox");
    const anchor = fixedAnchorOf(listbox);

    expect(anchor).not.toBeNull();
    expect(anchor!.style.position).toBe("fixed");
    expect(anchor!.style.left).toBe("40px");
    // input bottom (132) + 4px gap
    expect(anchor!.style.top).toBe("136px");
    expect(anchor!.style.width).toBe("240px");
    // above the dialog overlay's z-50
    expect(Number(anchor!.style.zIndex)).toBeGreaterThanOrEqual(60);
  });

  it("re-anchors the listbox when the dialog scrolls or the window resizes", async () => {
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    mockInputRect(input, { left: 40, top: 100, bottom: 132, width: 240 });
    await user.click(input);

    const listbox = await screen.findByRole("listbox");

    // The input moved (dialog content scrolled): capture-phase listeners must
    // re-read the rect. Fire both nested scroll and window resize so either
    // listener satisfies the contract.
    mockInputRect(input, { left: 40, top: 60, bottom: 92, width: 240 });
    fireEvent.scroll(screen.getByTestId("dialog-scroll"));
    fireEvent.resize(window);

    await waitFor(() => {
      const anchor = fixedAnchorOf(listbox);
      expect(anchor).not.toBeNull();
      expect(anchor!.style.top).toBe("96px");
    });
  });

  it("keeps input aria-controls pointing at the portaled listbox", async () => {
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);

    const listbox = await screen.findByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    // The wiring must reference the PORTALED listbox, not a leftover inline one.
    expect(screen.getByTestId("dialog-scroll").contains(listbox)).toBe(false);
  });
});

describe("RoleCombobox — behavior pins (must survive the portal refactor)", () => {
  it("commits a role on option click and keeps the list open for the next pick", async () => {
    const onAdd = vi.fn();
    renderWithProviders(<Harness onAdd={onAdd} />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);

    const option = await screen.findByRole("option", { name: /reviewer/i });
    await user.click(option);

    expect(onAdd).toHaveBeenCalledWith("reviewer");
    // Chip rendered for the committed role.
    expect(
      screen.getByRole("button", { name: /remove role reviewer/i }),
    ).toBeInTheDocument();
    // Multi-select: the list stays open, minus the role just picked.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /reviewer/i }),
    ).not.toBeInTheDocument();

    // A second pick works without re-focusing the input.
    await user.click(screen.getByRole("option", { name: /orchestrator/i }));
    expect(onAdd).toHaveBeenCalledWith("orchestrator");
    expect(
      screen.getByRole("button", { name: /remove role orchestrator/i }),
    ).toBeInTheDocument();
  });

  it("unmounts the list once every suggestion has been picked", async () => {
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);

    for (let picked = 0; picked < SUGGESTIONS.length; picked++) {
      const [first] = await screen.findAllByRole("option");
      await user.click(first!);
    }

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("commits the first filtered suggestion on Enter", async () => {
    const onAdd = vi.fn();
    renderWithProviders(<Harness onAdd={onAdd} />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);
    await user.type(input, "rev");
    await user.keyboard("{Enter}");

    expect(onAdd).toHaveBeenCalledWith("reviewer");
  });

  it("commits the free-text query on Enter when nothing matches (custom role)", async () => {
    const onAdd = vi.fn();
    renderWithProviders(<Harness onAdd={onAdd} />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);
    await user.type(input, "security-auditor");

    // The custom-role option is offered in the (portaled) list…
    expect(
      await screen.findByRole("option", { name: /security-auditor/i }),
    ).toBeInTheDocument();

    // …and Enter commits it.
    await user.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledWith("security-auditor");
  });

  it("closes the list on Escape without committing", async () => {
    const onAdd = vi.fn();
    renderWithProviders(<Harness onAdd={onAdd} />);
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);
    await screen.findByRole("listbox");

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("pops the last chip on Backspace when the input is empty", async () => {
    const onRemove = vi.fn();
    renderWithProviders(
      <Harness initialRoles={["orchestrator", "reviewer"]} onRemove={onRemove} />,
    );
    const user = userEvent.setup();

    const input = screen.getByRole("combobox", { name: /add role/i });
    await user.click(input);
    await user.keyboard("{Backspace}");

    expect(onRemove).toHaveBeenCalledWith("reviewer");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /remove role reviewer/i }),
      ).not.toBeInTheDocument(),
    );
  });
});
