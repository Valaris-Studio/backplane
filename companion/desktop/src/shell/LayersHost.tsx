// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence, m } from "motion/react";

import { AlertDialog } from "../components/AlertDialog";
import { Sheet } from "../components/Sheet";
import { ToastView } from "../components/ToastView";
import { useMotionTokens, useReducedMotionPreference } from "../motion/reduced-motion";
import { toastMotion } from "../motion/variants";
import { closeSheet, confirmActiveDialog, settleDialog, useLayersState, type SheetEntry, type ToastEntry } from "./layers";

const SHEET_CONTROLS = { close: closeSheet };

function SheetLayer({ entry }: { entry: SheetEntry }) {
  if (entry.kind === "custom") return entry.render(SHEET_CONTROLS);
  const { spec } = entry;
  return (
    <Sheet title={spec.title} onClose={closeSheet} footer={spec.footer?.(SHEET_CONTROLS)} returnFocusTo={spec.returnFocusTo ?? null}>
      {spec.render(SHEET_CONTROLS)}
    </Sheet>
  );
}

function ToastRegion({ kind, toast }: { kind: "status" | "alert"; toast: ToastEntry | null }) {
  const recipe = toastMotion(useMotionTokens(), useReducedMotionPreference());
  // The region itself never unmounts: a live region added together with its
  // text is not reliably announced, so only the toast inside it animates.
  return (
    <div role={kind} data-toast-region={kind} className="bp-toast-region">
      <AnimatePresence>
        {toast ? (
          // One slot per region: a newer toast replaces the text in place instead of stacking.
          <m.div key="toast" data-toast data-tone={toast.tone} className="bp-toast" initial={recipe.initial} animate={recipe.animate} exit={recipe.exit}>
            <ToastView message={toast.message} tone={toast.tone} />
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** One sheet, one dialog and one toast, drawn over the whole panel. */
export function LayersHost() {
  const { sheet, dialog, toast } = useLayersState();
  const isError = toast?.tone === "error";

  return (
    <>
      {/* A dialog over a sheet makes the sheet inert too; display:contents keeps the layer's positioning. */}
      <div className="contents" inert={dialog !== null}>
        <AnimatePresence>{sheet ? <SheetLayer key={sheet.id} entry={sheet} /> : null}</AnimatePresence>
      </div>
      <AnimatePresence>
        {dialog ? (
          <AlertDialog
            key={dialog.id}
            title={dialog.options.title}
            confirmLabel={dialog.options.confirmLabel}
            cancelLabel={dialog.options.cancelLabel ?? "Cancel"}
            tone={dialog.options.tone ?? "danger"}
            returnFocusTo={dialog.options.returnFocusTo ?? null}
            confirming={dialog.confirming}
            error={dialog.error}
            onConfirm={() => void confirmActiveDialog()}
            onCancel={() => settleDialog(false)}
          >
            {dialog.options.body}
          </AlertDialog>
        ) : null}
      </AnimatePresence>
      <ToastRegion kind="status" toast={toast && !isError ? toast : null} />
      <ToastRegion kind="alert" toast={toast && isError ? toast : null} />
    </>
  );
}
