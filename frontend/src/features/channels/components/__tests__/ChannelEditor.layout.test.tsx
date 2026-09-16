// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Channel } from "@/types/channel";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
// Mock specifier is resolved relative to THIS test file, not the component —
// the hook lives at src/features/channels/api/use-channels (two levels up + api).
vi.mock("../../api/use-channels", () => ({
  useUpdateChannel: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteChannel: () => ({ mutate: deleteMutate, isPending: false }),
}));

import { ChannelEditor } from "../ChannelEditor";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "chan-1",
    workspace_id: "ws-1",
    name: "Support inbox",
    channel_type: "email",
    contact_value: "support@acme.dev",
    description: "Primary support channel",
    metadata_json: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
});

describe("ChannelEditor — shared EditorSheet layout (pinned actions)", () => {
  // The Sheet's GSAP enter animation starts content at visibility:hidden, so
  // role queries (which skip inaccessible nodes) miss buttons mid-animation —
  // match on the button label TEXT instead. Save now lives ONLY in the footer —
  // the redundant header copy was removed (the footer floats above the content).
  const saveButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^save$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Save text not inside a button");
      return btn;
    });

  it("renders the name field and a single footer Save (no header title or duplicate)", () => {
    renderWithProviders(
      <ChannelEditor
        channel={makeChannel()}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByDisplayValue("Support inbox")).toBeInTheDocument();
    expect(screen.getByDisplayValue("support@acme.dev")).toBeInTheDocument();
    expect(saveButtons()).toHaveLength(1);
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
    // The self-explanatory "Edit Channel" heading is no longer VISIBLE — it
    // survives only sr-only, purely as the sheet's accessible name. Match by
    // text + selector: the GSAP enter animation leaves the sheet
    // visibility:hidden, which zeroes getByRole's computed accessible name.
    const heading = screen.getByText(/edit channel/i, { selector: "h2" });
    expect(heading.className).toContain("sr-only");
  });

  it("pins the action bar in a shrink-0 footer that is NOT inside the scrolling body", () => {
    renderWithProviders(
      <ChannelEditor
        channel={makeChannel()}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );
    // The footer Save (last in DOM order) must live in a shrink-0 region that is
    // a sibling of the scrolling body — never nested inside it (the legacy layout
    // buried actions via mt-auto inside the scroll area).
    const footerSave = saveButtons().at(-1)!;
    expect(footerSave.closest("div.shrink-0")).not.toBeNull();
    const scrollBody = document.querySelector(".flex-1.overflow-y-auto");
    expect(scrollBody).not.toBeNull();
    expect(scrollBody?.contains(footerSave)).toBe(false);
  });

  it("saves via the update mutation", async () => {
    // GSAP's enter animation leaves the sheet at visibility:hidden until it
    // settles, so userEvent's default pointer-events guard would refuse the
    // click. Disable that check (the layout test above covers visibility).
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ChannelEditor
        channel={makeChannel()}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );
    await user.click(saveButtons()[0]!);
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({ channelId: "chan-1" });
  });
});
