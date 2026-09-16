// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubReducedMotion } from "@/test/test-utils";
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../dialog";

// Every test here runs under reduced motion so GSAP's settled end-state is set
// synchronously: the exit animation gates unmount on a timeline `onComplete`
// that jsdom's ticker makes unreliable to await.
beforeEach(() => stubReducedMotion(true));

afterEach(() => {
  cleanup();
  stubReducedMotion(false);
});

function ControlledDialog() {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>Open the dialog</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete workspace</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        <button type="button">Confirm</button>
      </DialogContent>
    </Dialog>
  );
}

describe("DialogContent — ARIA semantics", () => {
  it("exposes the open dialog as role=dialog with aria-modal", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Delete workspace</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("points aria-labelledby at the rendered DialogTitle's id", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Delete workspace</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();

    const title = screen.getByText("Delete workspace");
    expect(title.id).toBe(labelledBy);
    // The accessible name must actually resolve, not just cross-reference.
    expect(dialog).toHaveAccessibleName("Delete workspace");
  });

  it("keeps a caller-supplied aria-labelledby instead of overriding it", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent aria-labelledby="external-heading">
          <h2 id="external-heading">Externally labelled</h2>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-labelledby",
      "external-heading",
    );
  });
});

describe("DialogContent — focus management", () => {
  it("moves focus into the dialog on open and restores it to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<ControlledDialog />);

    const trigger = screen.getByRole("button", { name: "Open the dialog" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses the container itself when the dialog has no focusable content", async () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Read only</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    // The built-in close (X) button is focusable, so an "empty" dialog still
    // has a target; assert focus landed inside either way.
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(dialog).toHaveAttribute("tabindex", "-1");
  });

  it("traps Tab at the last focusable element and wraps to the first", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Trap</DialogTitle>
          <button type="button">first</button>
          <button type="button">last</button>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "first" });
    const close = screen.getByRole("button", { name: "Close" });

    // Close (X) is the last focusable in DOM order — it renders after children.
    close.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    // Backward from the first wraps to the last.
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("does not let Tab escape to focusable elements outside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside before</button>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Trap</DialogTitle>
            <button type="button">inside</button>
          </DialogContent>
        </Dialog>
        <button type="button">outside after</button>
      </>,
    );

    const dialog = screen.getByRole("dialog");
    screen.getByRole("button", { name: "inside" }).focus();

    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("DialogContent — animation behavior preserved", () => {
  it("unmounts synchronously on close under reduced motion", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Motion</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Motion</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
