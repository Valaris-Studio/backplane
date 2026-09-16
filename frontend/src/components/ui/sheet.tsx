// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffectiveMaxWidth } from "@/hooks/use-effective-max-width";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

interface SheetContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // SheetTitle adopts this id and SheetContent points aria-labelledby at it, so
  // the accessible name wires up without consumers passing any new prop.
  titleId: string;
}

const SheetContext = React.createContext<SheetContextValue>({
  open: false,
  onOpenChange: () => {},
  titleId: "",
});

function Sheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  return (
    <SheetContext.Provider value={{ open, onOpenChange, titleId }}>
      {children}
    </SheetContext.Provider>
  );
}

function SheetTrigger({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onOpenChange } = React.useContext(SheetContext);
  return (
    <button type="button" onClick={() => onOpenChange(true)} {...props}>
      {children}
    </button>
  );
}

const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-5 overflow-y-auto border border-border/75 bg-card/95 p-6 shadow-panel backdrop-blur-xl transition-transform",
  {
    variants: {
      side: {
        top: "inset-x-4 top-4 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border-b",
        bottom: "inset-x-4 bottom-4 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border-t",
        left:
          "inset-y-4 left-4 h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-2rem))] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border-r",
        right:
          "inset-y-4 right-4 h-[calc(100%-2rem)] w-[min(38rem,calc(100vw-2rem))] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border-l",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
);

// Resize contract (opt-in via `resizable`) — the sheet's counterpart to the
// DialogContent contract, same prop names, DIFFERENT physics:
//   - A side sheet is EDGE-ANCHORED, so one pixel of pointer travel is one
//     pixel of width. The centered dialog's ×2 factor does not apply.
//   - The handle sits on the sheet's FREE edge: left for a right-snapped
//     sheet, right for a left-snapped one. The arrow keys follow that same
//     physical direction. There is no side override — the free edge is a fact
//     of the snap, not a preference.
//   - `top`/`bottom` sheets are height-anchored; horizontal resize is inert
//     there rather than rendering a handle on an edge that cannot move.
//   - Width is clamped to [minWidth, useEffectiveMaxWidth(maxWidth)], which
//     yields to 90vw so a stored width from a wide monitor cannot strand the
//     sheet off-screen on a narrow one. That same ceiling is what the handle
//     announces, so aria-valuemax never quotes an unreachable width.
//   - Double-click or Home resets to defaultWidth and forgets the preference.
//   - Persisted under `sheet-width:<resizeStorageKey>` — a namespace distinct
//     from the dialog's, because a width tuned against 1:1 edge-anchored
//     geometry must never restore onto a same-named centered dialog.
//   - Below the `sm` breakpoint the affordance is hidden and the inline width
//     is dropped, so mobile keeps the full-width behavior untouched.
//   - The affordance is an invisible full-height EDGE ZONE, not a pill: the
//     whole free edge is grabbable, so there is no small target to hunt for.
//     It stays a focusable `separator` carrying the same aria contract.
//   - An `!important` width utility in the consumer's className is STRIPPED
//     while resize is active. This is not cosmetic: `!w-[…]` beats a
//     non-important inline style in the real cascade, so leaving it in place
//     renders the sheet permanently pinned while state, aria and storage all
//     move — a resize that looks alive in tests and is dead on screen. The
//     dialog solves the same class-beats-inline problem with `sm:!max-w-none`;
//     a sheet's pin is an exact-width utility, which nothing can outrank, so
//     it has to go rather than be overridden.
// Opting out changes nothing: no affordance, no inline width, identical classes.
const KEYBOARD_RESIZE_STEP = 32;
const MOBILE_BREAKPOINT = 640;

// Matches Tailwind width utilities carrying an `!important` marker in either
// position (`!w-*` / `w-!*`), with or without a `sm:`-style variant prefix.
// Deliberately narrow: only WIDTH pins conflict with the inline resize width,
// so min-w/max-w and every non-width class survive untouched.
const IMPORTANT_WIDTH_UTILITY = /(?:^|\s)[^\s]*?!w-[^\s]*/g;

function stripImportantWidthUtilities(className: string | undefined): string {
  if (!className) return "";
  return className.replace(IMPORTANT_WIDTH_UTILITY, " ").trim();
}

function storageKeyFor(key: string): string {
  return `sheet-width:${key}`;
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.min(Math.max(width, min), max);
}

function readStoredWidth(
  key: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKeyFor(key));
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed, min, max) : null;
  } catch {
    // localStorage throws in privacy modes / disabled storage — fall back to
    // the default width rather than blocking the sheet from rendering.
    return null;
  }
}

function writeStoredWidth(key: string | undefined, width: number): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKeyFor(key), String(width));
  } catch {
    // Swallow quota / privacy errors; the width reverts to default on reload.
  }
}

function clearStoredWidth(key: string | undefined): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKeyFor(key));
  } catch {
    // Same degradation as writeStoredWidth.
  }
}

interface SheetResizeProps {
  resizable?: boolean;
  resizeStorageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  resizeHandleLabel?: string;
}

interface SheetContentProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof sheetVariants>,
    SheetResizeProps {
  /** Position/size override for the built-in close (X) — e.g. headerless edit
   *  sheets tuck it into a tighter corner so the body can start higher. */
  closeClassName?: string;
}

const SheetContentImpl = React.forwardRef<
  HTMLDivElement,
  SheetContentProps & {
    // Fired when the exit animation settles; the mount gate unmounts this impl
    // in response, which is what releases its listeners and effects.
    onExitComplete: () => void;
  }
>(
  (
    {
      side = "right",
      className,
      closeClassName,
      children,
      resizable = false,
      resizeStorageKey,
      defaultWidth = 608,
      minWidth = 384,
      maxWidth = 1280,
      resizeHandleLabel = "Resize panel width",
      onExitComplete,
      ...props
    },
    ref,
  ) => {
    const { open, onOpenChange, titleId } = React.useContext(SheetContext);
    const { t } = useTranslation();
    const reducedMotion = useReducedMotion();
    const overlayRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);

    React.useImperativeHandle(ref, () => contentRef.current as HTMLDivElement);

    // Trap only while genuinely open: this impl outlives `open` through the exit
    // animation, and restoring focus to the trigger must not wait for it.
    //
    // Initial focus is deferred: the enter animation starts the content at
    // `autoAlpha: 0` (= `visibility: hidden`), and browsers silently refuse to
    // focus inside a hidden subtree. Arming from the tween's completion is the
    // only point where the content is guaranteed visible.
    const armInitialFocus = useFocusTrap(contentRef, open, {
      deferInitialFocus: true,
    });

    // Lazily seeded from storage so a reopened sheet restores the operator's
    // width without a post-mount flash of the default.
    const [width, setWidth] = React.useState(
      () =>
        readStoredWidth(resizeStorageKey, minWidth, maxWidth) ?? defaultWidth,
    );
    const dragStateRef = React.useRef<{
      pointerX: number;
      width: number;
    } | null>(null);

    const effectiveMaxWidth = useEffectiveMaxWidth(maxWidth);

    const commitWidth = React.useCallback(
      (next: number) => {
        const clamped = clampWidth(next, minWidth, effectiveMaxWidth);
        setWidth(clamped);
        writeStoredWidth(resizeStorageKey, clamped);
      },
      [effectiveMaxWidth, minWidth, resizeStorageKey],
    );

    // The free edge is opposite the snap: a right-snapped sheet grows leftward
    // (travel toward smaller clientX), a left-snapped one rightward.
    const resizeHandleSide = side === "left" ? "right" : "left";
    const growthDirection = resizeHandleSide === "left" ? -1 : 1;

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      dragStateRef.current = { pointerX: event.clientX, width };
      // Pointer capture keeps the drag alive when the cursor outruns the edge
      // zone, and suppresses the text selection a bare mousemove drag causes.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      commitWidth(drag.width + (event.clientX - drag.pointerX) * growthDirection);
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    };

    const handleResetWidth = () => {
      setWidth(defaultWidth);
      clearStoredWidth(resizeStorageKey);
    };

    const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(width + KEYBOARD_RESIZE_STEP * growthDirection);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(width - KEYBOARD_RESIZE_STEP * growthDirection);
      } else if (event.key === "Home") {
        event.preventDefault();
        handleResetWidth();
      }
    };

    // Mobile keeps the untouched full-width layout: no inline width, no handle.
    const isCompactViewport =
      typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
    const isSidePanel = side === "left" || side === "right";
    const resizeActive = resizable && isSidePanel && !isCompactViewport;

    React.useEffect(() => {
      const overlay = overlayRef.current;
      const content = contentRef.current;
      if (!overlay || !content) return;

      const offset =
        side === "right"
          ? { x: 28, y: 0 }
          : side === "left"
            ? { x: -28, y: 0 }
            : side === "top"
              ? { x: 0, y: -28 }
              : { x: 0, y: 28 };

      if (reducedMotion) {
        if (open) {
          gsap.set([overlay, content], { autoAlpha: 1, x: 0, y: 0 });
          armInitialFocus();
        } else {
          onExitComplete();
        }
        return;
      }

      if (open) {
        gsap.set(overlay, { autoAlpha: 0 });
        gsap.set(content, { autoAlpha: 0, ...offset });
        const timeline = gsap.timeline({ onComplete: armInitialFocus });
        timeline.to(
          overlay,
          { autoAlpha: 1, duration: 0.16, ease: "power1.out" },
          0,
        );
        timeline.to(
          content,
          {
            autoAlpha: 1,
            x: 0,
            y: 0,
            duration: 0.24,
            ease: "power2.out",
          },
          0.02,
        );
        return () => { timeline.kill(); };
      }

      const timeline = gsap.timeline({ onComplete: onExitComplete });
      timeline.to(
        content,
        {
          autoAlpha: 0,
          x: offset.x * 0.5,
          y: offset.y * 0.5,
          duration: 0.18,
          ease: "power2.in",
        },
        0,
      );
      timeline.to(
        overlay,
        { autoAlpha: 0, duration: 0.16, ease: "power1.in" },
        0,
      );
      return () => { timeline.kill(); };
    }, [armInitialFocus, onExitComplete, open, reducedMotion, side]);

    // Portal to <body> so the sheet's `position: fixed` + `h-[calc(100%-2rem)]`
    // resolve against the VIEWPORT, not a transformed ancestor. The AppShell
    // content wrapper carries a GSAP `y` transform (page-enter animation), which
    // would otherwise become the containing block for `fixed` — stretching the
    // sheet to the full page scroll height and dropping the footer below the
    // fold on long boards. Mirrors DialogContent. SSR-safe behind the mount
    // gate.
    return createPortal(
      <>
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 bg-[color:color-mix(in_oklab,var(--color-background)_22%,black)]/72 backdrop-blur-md"
          onClick={() => onOpenChange(false)}
        />
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cn(
            sheetVariants({ side }),
            "focus:outline-none",
            // An exact-width `!w-*` pin would outrank the inline resize width
            // in the cascade and freeze the panel; drop it while resize is on.
            resizeActive ? stripImportantWidthUtilities(className) : className,
          )}
          style={
            resizeActive ? { width: `${width}px`, ...props.style } : props.style
          }
          {...props}
        >
          {children}
          {resizeActive && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={resizeHandleLabel}
              aria-valuenow={width}
              aria-valuemin={minWidth}
              aria-valuemax={effectiveMaxWidth}
              tabIndex={0}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onDoubleClick={handleResetWidth}
              onKeyDown={handleResizeKeyDown}
              className={cn(
                // Invisible full-height hit strip: the entire free edge is
                // grabbable, so there is no small pill to aim at. It only
                // paints on hover/focus, where a hairline confirms the grab.
                "absolute inset-y-0 hidden w-2 cursor-ew-resize bg-transparent transition-colors duration-200 hover:bg-primary/40 focus:bg-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block",
                resizeHandleSide === "left" ? "left-0" : "right-0",
              )}
            />
          )}
          <button
            type="button"
            className={cn(
              "absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-[background-color,border-color,color,opacity] duration-200 hover:border-border/70 hover:bg-accent hover:text-accent-foreground",
              closeClassName,
            )}
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        </div>
      </>,
      document.body,
    );
  },
);
SheetContentImpl.displayName = "SheetContentImpl";

// Mount gate (prod React error #185 + drag-FPS collapse): a closed SheetContent
// must cost nothing. The gate owns only the mounted lifecycle and bails BEFORE
// any expensive hook — resize listener, focus trap, width state and gsap all
// live in SheetContentImpl, which exists only while mounted. Unmounting the
// impl is what releases its listeners, so it waits for the exit animation to
// settle. Mirrors DialogContent.
const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  (props, ref) => {
    const { open } = React.useContext(SheetContext);
    const [mounted, setMounted] = React.useState(open);

    React.useEffect(() => {
      if (open) {
        setMounted(true);
      }
    }, [open]);

    // Stable identity: an inline closure would re-key the impl's animation
    // effect on every gate render and restart in-flight tweens.
    const handleExitComplete = React.useCallback(() => setMounted(false), []);

    if (!mounted) return null;

    return (
      <SheetContentImpl
        ref={ref}
        onExitComplete={handleExitComplete}
        {...props}
      />
    );
  },
);
SheetContent.displayName = "SheetContent";

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
    {...props}
  />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "mt-auto flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end",
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, id, ...props }, ref) => {
  const { titleId } = React.useContext(SheetContext);
  return (
    <h2
      ref={ref}
      id={id ?? titleId}
      className={cn(
        "text-2xl font-bold tracking-[-0.04em] text-foreground",
        className,
      )}
      {...props}
    />
  );
});
SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm leading-6 text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
