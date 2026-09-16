// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { CanvasSaveBar } from "../CanvasSaveBar";
import { ConflictBanner } from "../ConflictBanner";

describe("CanvasSaveBar", () => {
  it("is hidden when not dirty and has no errors", () => {
    const { container } = renderWithProviders(
      <CanvasSaveBar
        dirty={false}
        saving={false}
        errorCount={0}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Save/Discard when dirty and wires the callbacks", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    renderWithProviders(
      <CanvasSaveBar
        dirty
        saving={false}
        errorCount={0}
        onSave={onSave}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByTestId("canvas-save"));
    fireEvent.click(screen.getByTestId("canvas-discard"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("disables Save while there are validation errors or a save is in flight", () => {
    const { rerender } = renderWithProviders(
      <CanvasSaveBar dirty saving={false} errorCount={2} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByTestId("canvas-save")).toBeDisabled();
    rerender(
      <CanvasSaveBar dirty saving errorCount={0} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByTestId("canvas-save")).toBeDisabled();
  });
});

describe("ConflictBanner", () => {
  it("renders nothing when there is no conflict", () => {
    const { container } = renderWithProviders(
      <ConflictBanner conflict={null} onReload={vi.fn()} onOverwrite={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the version mismatch and wires reload + overwrite", () => {
    const onReload = vi.fn();
    const onOverwrite = vi.fn();
    renderWithProviders(
      <ConflictBanner
        conflict={{ currentVersion: 9, expectedVersion: 7 }}
        onReload={onReload}
        onOverwrite={onOverwrite}
        onDismiss={vi.fn()}
      />,
    );
    // The numbers reach the operator, not just the banner (card 16cde0c9).
    expect(screen.getByTestId("conflict-banner")).toHaveTextContent(
      /v9.*v7/,
    );
    fireEvent.click(screen.getByTestId("conflict-reload"));
    fireEvent.click(screen.getByTestId("conflict-overwrite"));
    expect(onReload).toHaveBeenCalledOnce();
    expect(onOverwrite).toHaveBeenCalledOnce();
  });

  it("hides the version line when the error carried no context", () => {
    renderWithProviders(
      <ConflictBanner
        conflict={{ currentVersion: null, expectedVersion: null }}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // Degrades to hidden rather than rendering "undefined"; recovery still works.
    expect(screen.getByTestId("conflict-banner")).not.toHaveTextContent(/v\d/);
    expect(screen.getByTestId("conflict-reload")).toBeInTheDocument();
  });
});
