// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
// The omitted-cancelLabel default resolves through i18next, which this suite's
// plain `render` does not otherwise initialize.
import "@/i18n/config";
import { ConfirmDialog } from "../confirm-dialog";

function renderConfirm(
  extra?: Partial<Parameters<typeof ConfirmDialog>[0]>,
) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this thing?"
      description="This cannot be undone."
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      {...extra}
    />,
  );
  return { onConfirm, onOpenChange };
}

function renderConfirmWithRerender(
  extra?: Partial<Parameters<typeof ConfirmDialog>[0]>,
) {
  const onConfirm = vi.fn();
  const props = {
    onOpenChange: vi.fn(),
    title: "Delete this thing?",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    onConfirm,
    ...extra,
  };
  const view = render(<ConfirmDialog open {...props} />);
  return {
    onConfirm,
    rerender: (open: boolean) =>
      view.rerender(<ConfirmDialog open={open} {...props} />),
  };
}

// The Dialog's GSAP enter animation starts content at visibility:hidden, so
// role queries (which skip inaccessible nodes) miss buttons mid-animation —
// match on the button label TEXT instead (same idiom as the editor tests).
const buttonByText = (label: string): HTMLButtonElement => {
  const btn = screen.getByText(label).closest("button");
  if (!btn) throw new Error(`"${label}" text is not inside a button`);
  return btn;
};

describe("ConfirmDialog", () => {
  it("renders title, description, and both action labels when open", () => {
    renderConfirm();
    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(buttonByText("Delete")).toBeInTheDocument();
    expect(buttonByText("Cancel")).toBeInTheDocument();
  });

  it("labels the cancel button by default when cancelLabel is omitted", () => {
    // Regression: a consumer that skipped cancelLabel shipped an EMPTY button.
    renderConfirm({ cancelLabel: undefined });
    expect(buttonByText("Cancel")).toBeInTheDocument();
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const { onConfirm } = renderConfirm();
    fireEvent.click(buttonByText("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onConfirm when cancel is clicked, and closes the dialog", () => {
    const { onConfirm, onOpenChange } = renderConfirm();
    fireEvent.click(buttonByText("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the confirm button with the destructive variant by default", () => {
    renderConfirm();
    expect(buttonByText("Delete").className).toContain("bg-destructive");
  });

  it("renders a default (non-destructive) confirm button when destructive=false", () => {
    renderConfirm({ destructive: false });
    expect(buttonByText("Delete").className).not.toContain("bg-destructive");
  });

  it("renders nothing when closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Hidden title"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByText("Hidden title")).not.toBeInTheDocument();
  });

  // A typed-confirmation gate exists so an unrecoverable action cannot be
  // completed by muscle memory: the operator must reproduce the name of the
  // thing being destroyed before the button is live.
  describe("typed confirmation", () => {
    it("disables confirm until the required phrase is typed exactly", () => {
      renderConfirm({ requirePhrase: "coder-bot", requirePhraseLabel: "Type coder-bot" });

      expect(buttonByText("Delete")).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Type coder-bot"), {
        target: { value: "coder-bot" },
      });

      expect(buttonByText("Delete")).not.toBeDisabled();
    });

    it("keeps confirm disabled for a near-miss phrase", () => {
      renderConfirm({ requirePhrase: "coder-bot", requirePhraseLabel: "Type coder-bot" });

      fireEvent.change(screen.getByLabelText("Type coder-bot"), {
        target: { value: "coder-bo" },
      });

      expect(buttonByText("Delete")).toBeDisabled();
    });

    it("does not fire onConfirm while the phrase is unmatched", () => {
      const { onConfirm } = renderConfirm({
        requirePhrase: "coder-bot",
        requirePhraseLabel: "Type coder-bot",
      });

      fireEvent.click(buttonByText("Delete"));

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("resets the typed phrase when the dialog closes, so a reopen re-asks", () => {
      const { rerender } = renderConfirmWithRerender({
        requirePhrase: "coder-bot",
        requirePhraseLabel: "Type coder-bot",
      });

      fireEvent.change(screen.getByLabelText("Type coder-bot"), {
        target: { value: "coder-bot" },
      });
      expect(buttonByText("Delete")).not.toBeDisabled();

      rerender(false);
      rerender(true);

      expect(buttonByText("Delete")).toBeDisabled();
    });

    it("shows no input and stays enabled when no phrase is required", () => {
      renderConfirm();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(buttonByText("Delete")).not.toBeDisabled();
    });
  });
});
