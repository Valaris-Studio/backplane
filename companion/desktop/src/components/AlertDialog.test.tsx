// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MotionProvider } from "../motion/MotionProvider";
import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../test/media";
import { AlertDialog } from "./AlertDialog";
import { Button } from "./Button";

function Harness({ onConfirm = () => {}, onCancel = () => {} }: { onConfirm?: () => void; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <MotionProvider>
      <Button variant="ghost-danger" onClick={() => setOpen(true)}>
        Disconnect…
      </Button>
      {open ? (
        <AlertDialog
          title="Disconnect this Mac?"
          confirmLabel="Disconnect"
          onConfirm={() => {
            setOpen(false);
            onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            onCancel();
          }}
        >
          <p>Capture stops and this Mac’s sign-in is deleted from the keychain.</p>
        </AlertDialog>
      ) : null}
    </MotionProvider>
  );
}

async function openDialog(handlers: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  render(<Harness {...handlers} />);
  const opener = screen.getByRole("button", { name: "Disconnect…" });
  opener.focus();
  await userEvent.click(opener);
  return opener;
}

describe("AlertDialog", () => {
  it("is a modal alertdialog named by its title and described by its body", async () => {
    await openDialog();
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect this Mac?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Capture stops and this Mac’s sign-in is deleted from the keychain.");
  });

  it("puts focus on Cancel, never on the destructive action", async () => {
    await openDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Disconnect" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveAttribute("data-variant", "danger");
  });

  it("cancels on Escape and returns focus to the opener", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const opener = await openDialog({ onCancel, onConfirm });
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it("confirms only from the confirm button", async () => {
    const onConfirm = vi.fn();
    await openDialog({ onConfirm });
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("does not cancel when the scrim is clicked", async () => {
    const onCancel = vi.fn();
    await openDialog({ onCancel });
    await userEvent.click(screen.getByTestId("dialog-scrim"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps Tab between its two buttons", async () => {
    await openDialog();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus();
  });

  it("scales in with full motion and only fades under reduced motion", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    await openDialog();
    const transform = screen.getByRole("alertdialog").style.transform;
    expect(transform === "" || transform === "none").toBe(true);
  });
});
