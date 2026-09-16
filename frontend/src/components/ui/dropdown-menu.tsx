// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
});

function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef }}>
      <div className="relative inline-block text-left">{children}</div>
    </DropdownMenuContext.Provider>
  );
}

// Always renders its own <button> — there is no asChild escape hatch, so
// callers style the trigger directly instead of wrapping another
// interactive element (which would nest <button><button>).
function DropdownMenuTrigger({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, setOpen, triggerRef } = React.useContext(DropdownMenuContext);
  return (
    <button
      ref={triggerRef}
      type="button"
      className={cn(
        "transition-[background-color,border-color,color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          setOpen(!open);
        }
      }}
      aria-expanded={open}
      {...props}
    >
      {children}
    </button>
  );
}

function DropdownMenuContent({
  children,
  className,
  align = "end",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end";
}) {
  const { open, setOpen, triggerRef } = React.useContext(DropdownMenuContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({ top: 0, left: 0 });

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current || !ref.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuHeight = ref.current.offsetHeight;
    const gap = 4;

    let top = triggerRect.bottom + gap;
    // Flip above trigger if menu overflows viewport bottom
    if (top + menuHeight > window.innerHeight) {
      top = triggerRect.top - menuHeight - gap;
    }
    // Constrain to viewport top if flipped menu also overflows
    if (top < 8) {
      top = 8;
    }

    setPosition({
      top,
      left: align === "end" ? triggerRect.right : triggerRect.left,
    });
  }, [open, align, triggerRef]);

  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        ref.current && !ref.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    function handleScroll(e: Event) {
      // Scrolling a bounded list INSIDE the menu must not dismiss it — only
      // page/container scroll outside the menu invalidates the anchored
      // position this close-on-scroll exists to protect.
      if (
        ref.current &&
        e.target instanceof Node &&
        ref.current.contains(e.target)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, setOpen, triggerRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: position.top,
        left: align === "end" ? "auto" : position.left,
        right: align === "end" ? window.innerWidth - position.left : "auto",
      }}
      className={cn(
        "z-50 min-w-[12rem] overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] border border-border/80 bg-popover/96 p-1.5 text-popover-foreground shadow-panel backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

function DropdownMenuItem({
  children,
  className,
  onClick,
  // Copy actions render a transient "copied" confirmation in place — closing
  // the menu on click would unmount that feedback before anyone sees it.
  closeOnClick = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { closeOnClick?: boolean }) {
  const { setOpen } = React.useContext(DropdownMenuContext);
  return (
    <div
      role="menuitem"
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.2rem))] px-3 py-2 text-sm outline-none transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-accent-foreground",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (closeOnClick) setOpen(false);
      }}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuSeparator({
  className,
}: {
  className?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-1 my-1 h-px bg-gradient-to-r from-transparent via-border to-transparent",
        className,
      )}
    />
  );
}

function DropdownMenuLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
};
