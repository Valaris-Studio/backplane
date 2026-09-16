// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

function setup(overrides: Partial<Parameters<typeof useUnsavedChangesGuard>[0]> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const view = renderHook(
    (props: Parameters<typeof useUnsavedChangesGuard>[0]) =>
      useUnsavedChangesGuard(props),
    {
      initialProps: {
        isDirty: true,
        onClose,
        onSave,
        canSave: true,
        ...overrides,
      },
    },
  );
  return { ...view, onClose, onSave };
}

describe("useUnsavedChangesGuard", () => {
  it("closes immediately and never opens the guard when the form is clean", () => {
    const { result, onClose } = setup({ isDirty: false });

    act(() => result.current.requestClose());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.guardOpen).toBe(false);
  });

  it("opens the guard and withholds the close when the form is dirty", () => {
    const { result, onClose } = setup({ isDirty: true });

    act(() => result.current.requestClose());

    expect(result.current.guardOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closeAnyway discards: closes without saving", () => {
    const { result, onClose, onSave } = setup({ isDirty: true });

    act(() => result.current.requestClose());
    act(() => result.current.closeAnyway());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.guardOpen).toBe(false);
  });

  it("closeAnyway resets the surface's draft BEFORE closing it", () => {
    const calls: string[] = [];
    const onDiscard = vi.fn(() => calls.push("discard"));
    const onClose = vi.fn(() => calls.push("close"));
    const { result } = renderHook(() =>
      useUnsavedChangesGuard({
        isDirty: true,
        onClose,
        onSave: vi.fn(),
        canSave: true,
        onDiscard,
      }),
    );

    act(() => result.current.requestClose());
    act(() => result.current.closeAnyway());

    expect(onDiscard).toHaveBeenCalledTimes(1);
    // Order matters: resetting after the close would race the surface's
    // unmount and leave the stale draft behind on reopen.
    expect(calls).toEqual(["discard", "close"]);
  });

  it("closeAnyway still closes when no onDiscard is supplied", () => {
    // Back-compat fence: BoardSettingsDialog and BoardLoopDialog already
    // re-sync on `open` and pass no onDiscard.
    const { result, onClose } = setup({ isDirty: true });

    act(() => result.current.requestClose());
    act(() => result.current.closeAnyway());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.guardOpen).toBe(false);
  });

  it("saveAndClose delegates to the surface's save path and does not close directly", () => {
    const { result, onClose, onSave } = setup({ isDirty: true });

    act(() => result.current.requestClose());
    act(() => result.current.saveAndClose());

    expect(onSave).toHaveBeenCalledTimes(1);
    // The surface's own mutation onSuccess owns the close — closing here would
    // dismiss the form before the request resolves and strand a failed save.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismissGuard leaves the surface open with the edit intact", () => {
    const { result, onClose, onSave } = setup({ isDirty: true });

    act(() => result.current.requestClose());
    act(() => result.current.dismissGuard());

    expect(result.current.guardOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("handleOpenChange(true) is inert — only closing is guarded", () => {
    const { result, onClose } = setup({ isDirty: true });

    act(() => result.current.handleOpenChange(true));

    expect(result.current.guardOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("handleOpenChange(false) routes through requestClose", () => {
    const { result, onClose } = setup({ isDirty: true });

    act(() => result.current.handleOpenChange(false));

    expect(result.current.guardOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports canSave so the prompt can hide Save on an unsavable draft", () => {
    const { result } = setup({ isDirty: true, canSave: false });

    expect(result.current.canSave).toBe(false);
  });
});
