// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";
type FixedPosition = { top: number; left: number };
const VIEWPORT_GUTTER = 8;

// The popover is rendered at the trigger anchor point and then translated into
// place via SIDE_TRANSFORMS (mirrors rich-tooltip.tsx).
const SIDE_TRANSFORMS: Record<Side, string> = {
  top: "-translate-x-1/2 -translate-y-full -mt-2",
  bottom: "-translate-x-1/2 mt-2",
  left: "-translate-x-full -translate-y-1/2 -ml-2",
  right: "-translate-y-1/2 ml-2",
};

function anchorFor(rect: DOMRect, side: Side): FixedPosition {
  switch (side) {
    case "top":
      return { top: rect.top, left: rect.left + rect.width / 2 };
    case "bottom":
      return { top: rect.bottom, left: rect.left + rect.width / 2 };
    case "left":
      return { top: rect.top + rect.height / 2, left: rect.left };
    case "right":
      return { top: rect.top + rect.height / 2, left: rect.right };
  }
}

type TooltipContextValue = {
  open: boolean;
  // Trigger anchor for positioning. Set by TooltipTrigger when present;
  // otherwise falls back to the wrapper span so consumers that drop the element
  // directly inside <Tooltip> (no TooltipTrigger) still anchor correctly.
  triggerRef: React.RefObject<HTMLElement | null>;
  hasTrigger: React.MutableRefObject<boolean>;
};

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Tooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const hasTrigger = React.useRef(false);

  return (
    <TooltipContext.Provider value={{ open, triggerRef, hasTrigger }}>
      {/* The wrapper hosts the hover/focus listeners AND serves as the default
          position anchor when no explicit TooltipTrigger is used. The CONTENT
          is portaled to <body> (see TooltipContent) so it escapes any
          overflow-hidden / clipping ancestor — z-index alone cannot. */}
      <span
        ref={(node) => {
          if (!hasTrigger.current) triggerRef.current = node;
        }}
        data-tooltip-root=""
        className="relative inline-flex"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
    </TooltipContext.Provider>
  );
}

function TooltipTrigger({
  children,
  asChild,
}: {
  children: React.ReactNode;
  asChild?: boolean;
}) {
  const ctx = React.useContext(TooltipContext);
  const setRef = (node: HTMLElement | null) => {
    if (!ctx) return;
    // An explicit TooltipTrigger takes precedence over the wrapper-span fallback.
    if (node) ctx.hasTrigger.current = true;
    ctx.triggerRef.current = node;
  };

  // When asChild, clone the single child and attach the ref so we can measure
  // its rect. Otherwise wrap in a span we can ref.
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{ ref?: React.Ref<HTMLElement> }>;
    const childRef = (child as { ref?: React.Ref<HTMLElement> }).ref;
    return React.cloneElement(child, {
      ref: (node: HTMLElement | null) => {
        setRef(node);
        if (typeof childRef === "function") childRef(node);
        else if (childRef && typeof childRef === "object")
          (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
      },
    });
  }

  return (
    <span ref={setRef} className="inline-flex">
      {children}
    </span>
  );
}

function TooltipContent({
  children,
  className,
  side = "top",
  variant = "default",
  avoidCollisions = false,
}: {
  children: React.ReactNode;
  className?: string;
  side?: Side;
  variant?: "default" | "info";
  avoidCollisions?: boolean;
}) {
  const ctx = React.useContext(TooltipContext);
  const open = ctx?.open ?? false;
  const [position, setPosition] = React.useState<FixedPosition>({ top: 0, left: 0 });
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  // Re-measure the trigger every time the tooltip opens so the fixed-position
  // popover tracks the trigger's current viewport location. We render as soon
  // as `open` (not gated on a measured position) so the tooltip never gets
  // stuck closed if a rect read returns nothing (e.g. jsdom) — it just anchors
  // at 0,0 until the layout effect refines it.
  React.useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = ctx?.triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = anchorFor(rect, side);
      const content = contentRef.current;
      if (avoidCollisions && content) {
        const bounds = content.getBoundingClientRect();
        // Measure the rendered offset so side transforms and caller margins
        // remain authoritative even when the fixed anchor needs to shift.
        const left = next.left + bounds.left - (Number.parseFloat(content.style.left) || 0);
        const top = next.top + bounds.top - (Number.parseFloat(content.style.top) || 0);
        const clampedLeft = Math.max(VIEWPORT_GUTTER, Math.min(left, window.innerWidth - bounds.width - VIEWPORT_GUTTER));
        const clampedTop = Math.max(VIEWPORT_GUTTER, Math.min(top, window.innerHeight - bounds.height - VIEWPORT_GUTTER));
        next.left += clampedLeft - left;
        next.top += clampedTop - top;
      }
      setPosition((previous) => previous.top === next.top && previous.left === next.left ? previous : next);
    };
    updatePosition();
    if (!avoidCollisions) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [open, side, ctx, avoidCollisions]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={contentRef}
      role="tooltip"
      style={{
        position: "fixed", top: position.top, left: position.left,
        ...(avoidCollisions ? {
          maxWidth: `calc(100vw - ${VIEWPORT_GUTTER * 2}px)`,
          maxHeight: `calc(100vh - ${VIEWPORT_GUTTER * 2}px)`,
          overflow: "auto",
        } : {}),
      }}
      className={cn(
        "z-[60] overflow-hidden border border-border/70 bg-popover/96 px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-soft backdrop-blur-xl",
        variant === "default" && "rounded-full",
        variant === "info" &&
          "w-64 rounded-[var(--radius-md)] font-normal leading-relaxed",
        SIDE_TRANSFORMS[side],
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
