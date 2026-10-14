// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactElement, ReactNode } from "react";

import type { ToastTone } from "../components/ToastView";
import { createExternalStore, useStoreSelector } from "../stores/external-store";

export const TOAST_DURATION_MS = 3200;

export interface SheetControls {
  close: () => void;
}

/** A sheet the shell draws: its title, body and optional footer actions. */
export interface SheetSpec {
  title: string;
  render: (controls: SheetControls) => ReactNode;
  footer?: (controls: SheetControls) => ReactNode;
  returnFocusTo?: HTMLElement | null;
  onClose?: () => void;
}

/**
 * For stateful sheets: the render returns its own <Sheet> element, so body and
 * footer can share state (a board picker whose Bind button needs the
 * selection). Use openSheet for stateless ones.
 */
export type CustomSheetRender = (controls: SheetControls) => ReactElement;

/** Handed to onConfirm: changes that dialog only, never one that replaced it. */
export interface DialogHandle {
  update: (changes: Partial<Omit<ConfirmOptions, "onConfirm">>) => void;
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  returnFocusTo?: HTMLElement | null;
  /**
   * The action itself (disconnect, remove). The dialog stays open with a busy
   * confirm button until it settles; a rejection shows its message inline and
   * keeps the dialog open for a retry or Cancel.
   */
  onConfirm?: (dialog: DialogHandle) => unknown;
}

export type SheetEntry = { id: number } & ({ kind: "spec"; spec: SheetSpec } | { kind: "custom"; render: CustomSheetRender; onClose?: () => void });
export type DialogEntry = {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
  confirming: boolean;
  error: string | null;
};
export type ToastEntry = { id: number; message: string; tone: ToastTone };

export interface LayersState {
  sheet: SheetEntry | null;
  dialog: DialogEntry | null;
  toast: ToastEntry | null;
}

const EMPTY: LayersState = { sheet: null, dialog: null, toast: null };
export const layersStore = createExternalStore<LayersState>(EMPTY);

let nextLayerId = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function sheetOnClose(entry: SheetEntry): (() => void) | undefined {
  return entry.kind === "spec" ? entry.spec.onClose : entry.onClose;
}

/** Opens a sheet, replacing any open one (there is only ever one). */
export function openSheet(spec: SheetSpec): void {
  nextLayerId += 1;
  layersStore.set({ ...layersStore.get(), sheet: { id: nextLayerId, kind: "spec", spec } });
}

export function presentSheet(render: CustomSheetRender, options: { onClose?: () => void } = {}): void {
  nextLayerId += 1;
  const entry: SheetEntry = options.onClose
    ? { id: nextLayerId, kind: "custom", render, onClose: options.onClose }
    : { id: nextLayerId, kind: "custom", render };
  layersStore.set({ ...layersStore.get(), sheet: entry });
}

export function closeSheet(): void {
  const { sheet } = layersStore.get();
  if (!sheet) return;
  layersStore.set({ ...layersStore.get(), sheet: null });
  sheetOnClose(sheet)?.();
}

/** Asks an alert-dialog question; resolves true only on the confirm button. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    layersStore.get().dialog?.resolve(false);
    nextLayerId += 1;
    layersStore.set({ ...layersStore.get(), dialog: { id: nextLayerId, options, resolve, confirming: false, error: null } });
  });
}

const GENERIC_FAILURE = "That didn’t work. Try again.";

function failureMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string" && reason.message) return reason.message;
  return GENERIC_FAILURE;
}

function patchDialog(id: number, patch: Partial<Pick<DialogEntry, "confirming" | "error">>): void {
  const { dialog } = layersStore.get();
  if (dialog?.id !== id) return;
  layersStore.set({ ...layersStore.get(), dialog: { ...dialog, ...patch } });
}

/**
 * Changes dialog `id`'s copy in place, e.g. a confirm button that must say
 * something else after a partly failed action. Its busy and error state stay.
 */
function updateDialog(id: number, changes: Partial<Omit<ConfirmOptions, "onConfirm">>): void {
  const { dialog } = layersStore.get();
  if (dialog?.id !== id) return;
  layersStore.set({ ...layersStore.get(), dialog: { ...dialog, options: { ...dialog.options, ...changes } } });
}

export function settleDialog(confirmed: boolean): void {
  const { dialog } = layersStore.get();
  if (!dialog || dialog.confirming) return;
  layersStore.set({ ...layersStore.get(), dialog: null });
  dialog.resolve(confirmed);
}

/** The confirm button: runs onConfirm if there is one, and closes only once it succeeds. */
export async function confirmActiveDialog(): Promise<void> {
  const { dialog } = layersStore.get();
  if (!dialog || dialog.confirming) return;
  const action = dialog.options.onConfirm;
  if (!action) {
    settleDialog(true);
    return;
  }
  patchDialog(dialog.id, { confirming: true, error: null });
  try {
    await action({ update: (changes) => updateDialog(dialog.id, changes) });
  } catch (reason) {
    patchDialog(dialog.id, { confirming: false, error: failureMessage(reason) });
    return;
  }
  patchDialog(dialog.id, { confirming: false });
  settleDialog(true);
}

export function showToast(message: string, options: { tone?: ToastTone } = {}): void {
  nextLayerId += 1;
  const id = nextLayerId;
  layersStore.set({ ...layersStore.get(), toast: { id, message, tone: options.tone ?? "success" } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dismissToast(id), TOAST_DURATION_MS);
}

export function dismissToast(id: number): void {
  if (layersStore.get().toast?.id !== id) return;
  layersStore.set({ ...layersStore.get(), toast: null });
}

export function useLayersState(): LayersState {
  return useStoreSelector(layersStore, (state) => state);
}

/** True while a sheet or dialog is up, so the panel behind it goes inert. */
export function useModalLayerOpen(): boolean {
  return useStoreSelector(layersStore, (state) => state.sheet !== null || state.dialog !== null);
}

const SHEET_API = { open: openSheet, present: presentSheet, close: closeSheet };
const DIALOG_API = { confirm: confirmDialog };
const TOAST_API = { show: showToast };

export function useSheet() {
  return SHEET_API;
}

export function useDialog() {
  return DIALOG_API;
}

export function useToast() {
  return TOAST_API;
}

export function resetLayersForTests(): void {
  clearTimeout(toastTimer);
  layersStore.get().dialog?.resolve(false);
  layersStore.set(EMPTY);
}
