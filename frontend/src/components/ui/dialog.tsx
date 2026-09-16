// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { useEffectiveMaxWidth } from "@/hooks/use-effective-max-width";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // DialogTitle adopts this id and DialogContent points aria-labelledby at it,
  // so the accessible name wires up without consumers passing any new prop.
  titleId: string;
}

const DialogContext = React.createContext<DialogContextValue>({
  open: false,
  onOpenChange: () => {},
  titleId: "",
});

function Dialog({
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
    <DialogContext.Provider value={{ open, onOpenChange, titleId }}>
      {children}
    </DialogContext.Provider>
  );
}

// No `asChild`: this trigger always renders its own <button>. Advertising the
// prop without implementing child composition invites nested-button DOM bugs
// (same reasoning as DropdownMenuTrigger's deliberate omission).
function DialogTrigger({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onOpenChange } = React.useContext(DialogContext);
  return (
    <button type="button" onClick={() => onOpenChange(true)} {...props}>
      {children}
    </button>
  );
}

// Portal to <body> so the dialog's `fixed inset-0` centering resolves against
// the viewport. Without this the dialog stays a descendant of the AppShell
// content wrapper, which carries a GSAP route-transition transform — and a
// transformed ancestor makes `position: fixed` resolve against that ancestor
// instead of the viewport, so the dialog drifts off-screen on scrolled pages.
function DialogPortal({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const { onOpenChange } = React.useContext(DialogContext);
  return (
    <div
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 bg-[color:color-mix(in_oklab,var(--color-background)_28%,black)]/75 backdrop-blur-md",
        className,
      )}
      onClick={() => onOpenChange(false)}
      {...props}
    />
  );
});
DialogOverlay.displayName = "DialogOverlay";

// Resize contract (opt-in via `resizable`):
//   - An invisible full-height EDGE ZONE on the LEFT edge by default, grabbable
//     anywhere along it rather than at one small handle. The right edge shares
//     a screen region with the page scrollbar, which cost operators the
//     affordance entirely; `resizeHandleSide="right"` is the escape hatch for
//     surfaces whose left edge is occupied.
//   - The dialog is viewport-centered, so it grows from BOTH edges and one
//     pixel of pointer travel is two pixels of width. Growth is toward the
//     handle's own edge: pointer LEFT grows a left handle, pointer RIGHT grows
//     a right one — and the arrow keys follow the same physical direction.
//   - Width is clamped to [minWidth, useEffectiveMaxWidth(maxWidth)], which
//     yields to 90vw so a stored width from a wide monitor cannot strand the
//     dialog off-screen on a narrow one. That same ceiling is what the handle
//     announces, so aria-valuemax never quotes an unreachable width.
//   - Double-click resets to defaultWidth and forgets the stored preference.
//   - Arrow keys resize by KEYBOARD_RESIZE_STEP; the handle is a focusable
//     `separator` carrying aria-valuenow/min/max.
//   - Persisted per dialog under `dialog-width:<resizeStorageKey>`.
//   - Below the `sm` breakpoint the handle is hidden and the inline width is
//     dropped, so mobile keeps the full-width behavior untouched.
// Opting out changes nothing: no handle, no inline width, identical classes.
const KEYBOARD_RESIZE_STEP = 32;
const MOBILE_BREAKPOINT = 640;

function storageKeyFor(key: string): string {
  return `dialog-width:${key}`;
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
    // the default width rather than blocking the dialog from rendering.
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

interface DialogResizeProps {
  resizable?: boolean;
  resizeStorageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  resizeHandleLabel?: string;
  resizeHandleSide?: "left" | "right";
}

type DialogContentProps = React.HTMLAttributes<HTMLDivElement> &
  DialogResizeProps;

const DialogContentImpl = React.forwardRef<
  HTMLDivElement,
  DialogContentProps & {
    // Fired when the exit animation settles; the mount gate unmounts this impl
    // in response, which is what releases its listeners and effects.
    onExitComplete: () => void;
  }
>((
  {
    className,
    children,
    resizable = false,
    resizeStorageKey,
    defaultWidth = 672,
    minWidth = 672,
    maxWidth = 1280,
    resizeHandleLabel = "Resize dialog",
    resizeHandleSide = "left",
    onExitComplete,
    ...props
  },
  ref,
) => {
  const { open, onOpenChange, titleId } = React.useContext(DialogContext);
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useImperativeHandle(ref, () => contentRef.current as HTMLDivElement);

  // Trap only while genuinely open: this impl outlives `open` through the exit
  // animation, and restoring focus to the trigger must not wait for it.
  //
  // Initial focus is deferred: the enter animation starts the content at
  // `opacity: 0`, and grabbing focus before the tween settles reads as a
  // flash. Arming from the tween's completion is the calm point. (The content
  // deliberately animates `opacity`, not `autoAlpha`: `visibility: hidden`
  // would drop the dialog out of the accessibility tree until the first GSAP
  // tick, which screen readers — and role queries in tests — see as the
  // dialog not existing yet.)
  const armInitialFocus = useFocusTrap(contentRef, open, {
    deferInitialFocus: true,
  });

  // Lazily seeded from storage so a reopened dialog restores the operator's
  // width without a post-mount flash of the default.
  const [width, setWidth] = React.useState(
    () => readStoredWidth(resizeStorageKey, minWidth, maxWidth) ?? defaultWidth,
  );
  const dragStateRef = React.useRef<{ pointerX: number; width: number } | null>(
    null,
  );

  const effectiveMaxWidth = useEffectiveMaxWidth(maxWidth);

  // Clamp at RENDER time, not only in commitWidth: the default/stored width is
  // applied before any drag, and on a viewport narrower than it the dialog
  // would otherwise overflow and scroll horizontally. clampWidth applies the
  // max last, so the viewport ceiling wins even over minWidth.
  const renderedWidth = clampWidth(width, minWidth, effectiveMaxWidth);

  const commitWidth = React.useCallback(
    (next: number) => {
      const clamped = clampWidth(next, minWidth, effectiveMaxWidth);
      setWidth(clamped);
      writeStoredWidth(resizeStorageKey, clamped);
    },
    [effectiveMaxWidth, minWidth, resizeStorageKey],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = { pointerX: event.clientX, width };
    // Pointer capture keeps the drag alive when the cursor outruns the 6px
    // handle, and suppresses the text selection a bare mousemove drag causes.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  // +1 when travel toward larger clientX grows the dialog (right handle), -1
  // when it shrinks it (left handle). The ×2 centered-geometry factor is the
  // same on both edges.
  const growthDirection = resizeHandleSide === "left" ? -1 : 1;

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    commitWidth(
      drag.width + (event.clientX - drag.pointerX) * 2 * growthDirection,
    );
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
  const resizeActive = resizable && !isCompactViewport;

  React.useEffect(() => {
    const overlay = overlayRef.current;
    const content = contentRef.current;
    if (!overlay || !content) return;

    if (reducedMotion) {
      if (open) {
        gsap.set([overlay, content], { autoAlpha: 1, y: 0, scale: 1 });
        armInitialFocus();
      } else {
        onExitComplete();
      }
      return;
    }

    if (open) {
      gsap.set(overlay, { autoAlpha: 0 });
      gsap.set(content, { opacity: 0, y: 18, scale: 0.96 });
      const timeline = gsap.timeline({ onComplete: armInitialFocus });
      timeline.to(
        overlay,
        { autoAlpha: 1, duration: 0.16, ease: "power1.out" },
        0,
      );
      timeline.to(
        content,
        { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: "power2.out" },
        0.02,
      );
      return () => { timeline.kill(); };
    }

    const timeline = gsap.timeline({ onComplete: onExitComplete });
    timeline.to(
      content,
      { opacity: 0, y: 14, scale: 0.97, duration: 0.18, ease: "power2.in" },
      0,
    );
    timeline.to(
      overlay,
      { autoAlpha: 0, duration: 0.16, ease: "power1.in" },
      0,
    );
    return () => { timeline.kill(); };
  }, [armInitialFocus, onExitComplete, open, reducedMotion]);

  return (
    <DialogPortal>
      <DialogOverlay ref={overlayRef} />
      {/* Flex-centering wrapper: the wrapper owns viewport-centered position
          via `fixed inset-0` + flex. The content ref is a flex child, so
          gsap's `y`/`scale` animations transform the child without clobbering
          any Tailwind translate-based centering. Previous implementation used
          `translate-[-50%,-50%]` on the content node itself; gsap overwrote
          that transform on animation settle and the dialog drifted off-center
          on pages with scrolled content. */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 pointer-events-none"
      >
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cn(
            "pointer-events-auto grid w-full max-w-xl max-h-[calc(100dvh-1.5rem)] gap-4 overflow-y-auto rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border border-border/75 bg-card/95 p-5 shadow-panel backdrop-blur-xl focus:outline-none sm:p-6",
            // An inline width must beat the consumer's `sm:max-w-*` utility, or
            // the drag would silently cap at the class-declared maximum.
            resizeActive && "sm:!max-w-none",
            className,
          )}
          style={
            resizeActive
              ? { width: `${renderedWidth}px`, ...props.style }
              : props.style
          }
          {...props}
        >
          {children}
          {resizeActive && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={resizeHandleLabel}
              aria-valuenow={renderedWidth}
              aria-valuemin={minWidth}
              aria-valuemax={effectiveMaxWidth}
              tabIndex={0}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onDoubleClick={handleResetWidth}
              onKeyDown={handleResizeKeyDown}
              className={cn(
                // Invisible full-height hit strip along the chosen free edge —
                // grabbable anywhere, painting only on hover/focus. Mirrors the
                // sheet's edge zone so both surfaces are grabbed the same way.
                "absolute inset-y-0 hidden w-2 cursor-ew-resize bg-transparent transition-colors duration-200 hover:bg-primary/40 focus:bg-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block",
                resizeHandleSide === "left" ? "left-0" : "right-0",
              )}
            />
          )}
          <button
            type="button"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-[background-color,border-color,color,opacity] duration-200 hover:border-border/70 hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        </div>
      </div>
    </DialogPortal>
  );
});
DialogContentImpl.displayName = "DialogContentImpl";

// Mount gate (prod React error #185 + drag-FPS collapse): KanbanCard mounts one
// CLOSED delete-confirm DialogContent per card, so a closed dialog must cost
// nothing. The gate owns only the mounted lifecycle and bails BEFORE any
// expensive hook — resize listener, focus trap, width state and gsap all live
// in DialogContentImpl, which exists only while mounted. Unmounting the impl is
// what releases its listeners, so it waits for the exit animation to settle.
const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (props, ref) => {
    const { open } = React.useContext(DialogContext);
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
      <DialogContentImpl
        ref={ref}
        onExitComplete={handleExitComplete}
        {...props}
      />
    );
  },
);
DialogContent.displayName = "DialogContent";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, id, ...props }, ref) => {
  const { titleId } = React.useContext(DialogContext);
  return (
    <h2
      ref={ref}
      id={id ?? titleId}
      className={cn(
        "text-xl font-bold leading-tight tracking-[-0.04em]",
        className,
      )}
      {...props}
    />
  );
});
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm leading-6 text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
