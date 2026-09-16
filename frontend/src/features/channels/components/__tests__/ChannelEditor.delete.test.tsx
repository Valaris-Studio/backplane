// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Channel } from "@/types/channel";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
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

// The Dialog's GSAP enter animation leaves content visibility:hidden, so match
// on TEXT and disable userEvent's pointer-events guard.
const byButtonText = (label: RegExp): HTMLButtonElement => {
  const btn = screen.getAllByText(label).at(-1)?.closest("button");
  if (!btn) throw new Error(`no button for ${label}`);
  return btn;
};

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
  confirmSpy = vi.spyOn(window, "confirm");
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe("ChannelEditor — delete is gated by ConfirmDialog (no window.confirm)", () => {
  it("does not delete on the footer Delete click alone — it opens a confirm dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ChannelEditor channel={makeChannel()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.click(byButtonText(/^delete$/i));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteMutate).not.toHaveBeenCalled();
    // The confirm dialog body (the existing deleteConfirm string) is now visible.
    expect(screen.getByText("Delete this channel?")).toBeInTheDocument();
  });

  it("deletes only after confirming in the dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ChannelEditor channel={makeChannel()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.click(byButtonText(/^delete$/i)); // open dialog
    await user.click(byButtonText(/^delete$/i)); // confirm in dialog
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0]![0]).toBe("chan-1");
  });

  it("cancel closes the dialog without deleting", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ChannelEditor channel={makeChannel()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.click(byButtonText(/^delete$/i)); // open dialog
    await user.click(byButtonText(/^cancel$/i));
    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
