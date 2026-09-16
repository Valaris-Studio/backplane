// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface EditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible heading. Omit it for a self-explanatory editor — the header band
   *  collapses and the sheet is named for screen readers via `a11yTitle`. */
  title?: ReactNode;
  description?: ReactNode;
  /** Screen-reader name for the sheet region when no visible `title` is shown.
   *  Keeps the dialog named without a redundant on-screen heading. */
  a11yTitle?: string;
  /** Pinned to the header's right edge — e.g. a Save button reachable without
   *  scrolling a tall form. Sits left of the sheet's absolute close (X). */
  headerActions?: ReactNode;
  /** The pinned action bar at the bottom (save/delete/cancel). Omit for a
   *  read-only sheet. */
  footer?: ReactNode;
  /** Width override for the panel; defaults to the standard edit width.
   *  Dropped once `resizable` is on — an `!important` width utility outranks
   *  the sheet's inline resize width, so the sheet strips it and `defaultWidth`
   *  becomes the single source of width. */
  widthClassName?: string;
  /** Opt in to the sheet's drag-to-resize contract. Requires a storage key so
   *  the operator's width is remembered per surface, not shared across them. */
  resizable?: boolean;
  resizeStorageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  resizeHandleLabel?: string;
  /** Extra classes for the scrolling body — e.g. a tighter top padding when the
   *  consumer's first row clears the close (X) horizontally itself. */
  bodyClassName?: string;
  children: ReactNode;
}

// The single layout for right-side edit sheets: a pinned header band, a body
// that scrolls INTERNALLY, and a pinned footer action bar. `p-0 overflow-hidden`
// hands scroll ownership to the body so the header/footer never leave the
// viewport no matter how tall the form grows (modeled on CardDetailSheet, which
// was the only editor that got this right — every other editor used the default
// whole-sheet scroll and buried its actions below the fold).
export function EditorSheet({
  open,
  onOpenChange,
  title,
  description,
  a11yTitle,
  headerActions,
  footer,
  widthClassName = "!w-[min(38rem,calc(100vw-2rem))]",
  bodyClassName,
  resizable,
  resizeStorageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  resizeHandleLabel,
  children,
}: EditorSheetProps) {
  const { t } = useTranslation();
  const hasVisibleHeader = Boolean(title || description || headerActions);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("gap-0 overflow-hidden p-0", widthClassName)}
        resizable={resizable}
        resizeStorageKey={resizeStorageKey}
        defaultWidth={defaultWidth}
        minWidth={minWidth}
        maxWidth={maxWidth}
        resizeHandleLabel={resizeHandleLabel}
        // Headerless sheets tuck the close (X) into a tight corner so the body
        // can start almost at the top — the X row IS the whole header.
        closeClassName={
          hasVisibleHeader ? undefined : "right-3 top-3 h-8 w-8"
        }
      >
        {hasVisibleHeader ? (
          // pr-14 clears the absolute close (X) the sheet renders at right-4.
          <SheetHeader className="shrink-0 border-b border-border/60 py-6 pl-6 pr-14">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                {title ? <SheetTitle>{title}</SheetTitle> : null}
                {description ? (
                  <SheetDescription>{description}</SheetDescription>
                ) : null}
              </div>
              {headerActions ? (
                <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
              ) : null}
            </div>
          </SheetHeader>
        ) : (
          // No visible heading, but the region still needs an accessible name
          // (this Sheet has no Radix aria-labelledby wiring — a plain sr-only
          // title is the name source). pt-6 keeps the body clear of the close (X).
          <SheetTitle className="sr-only">
            {a11yTitle ?? t("editor.a11yTitle")}
          </SheetTitle>
        )}

        <div
          className={cn(
            "flex-1 space-y-5 overflow-y-auto px-6 py-5",
            // With the header band gone, only the compact close (X, 32px at
            // top-3) needs clearing — pt-11 starts the body flush under it.
            // Consumers whose first row dodges the X horizontally can override
            // via bodyClassName (e.g. "pt-3", see NoteEditor).
            hasVisibleHeader ? undefined : "pt-11",
            bodyClassName,
          )}
        >
          {children}
        </div>

        {footer ? (
          <div className="shrink-0 border-t border-border/60 px-6 py-4">{footer}</div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
