// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

interface SelectContextValue {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // Items register their value→label mapping on mount so SelectValue can show
  // the chosen item's label without callers having to mirror the labels twice.
  registerItem: (value: string, label: React.ReactNode) => void;
  unregisterItem: (value: string) => void;
  labelFor: (value: string) => React.ReactNode;
  // Stable IDs let the trigger announce `aria-controls`/`aria-activedescendant`
  // for screen-reader users; the listbox + items mirror the same root ID.
  listboxId: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const SelectContext = React.createContext<SelectContextValue>({
  value: "",
  onValueChange: () => {},
  open: false,
  setOpen: () => {},
  registerItem: () => {},
  unregisterItem: () => {},
  labelFor: () => null,
  listboxId: "",
  triggerRef: { current: null },
});

function Select({ value, onValueChange, children, className }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const labelsRef = React.useRef(new Map<string, React.ReactNode>());
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const listboxId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = React.useRef(false);

  // Return focus to the trigger when the listbox closes (a11y: ephemeral popup
  // pattern). Only fires on the open→closed transition so the trigger isn't
  // re-focused on mount.
  React.useEffect(() => {
    if (wasOpenRef.current && !open) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  const registerItem = React.useCallback(
    (itemValue: string, label: React.ReactNode) => {
      labelsRef.current.set(itemValue, label);
      forceUpdate();
    },
    [],
  );
  const unregisterItem = React.useCallback((itemValue: string) => {
    labelsRef.current.delete(itemValue);
    forceUpdate();
  }, []);
  const labelFor = React.useCallback(
    (itemValue: string) => labelsRef.current.get(itemValue) ?? null,
    [],
  );

  return (
    <SelectContext.Provider
      value={{
        value,
        onValueChange,
        open,
        setOpen,
        registerItem,
        unregisterItem,
        labelFor,
        listboxId,
        triggerRef,
      }}
    >
      <div className={cn("relative", className)}>{children}</div>
    </SelectContext.Provider>
  );
}

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, children, ...props }, ref) => {
  const { open, setOpen, listboxId, triggerRef } = React.useContext(SelectContext);
  // Compose the forwarded ref with the context's triggerRef so the popup can
  // return focus here when it closes.
  const mergedRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
    },
    [ref, triggerRef],
  );
  return (
    <button
      ref={mergedRef}
      type="button"
      className={cn(
        "flex h-11 w-full items-center justify-between whitespace-nowrap rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] border border-input/85 bg-[color:var(--color-surface-1)] px-3.5 py-2 text-sm text-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_38%,transparent)] transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        className,
      )}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          setOpen(!open);
        }
      }}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      {...props}
    >
      {children}
      <ChevronDown
        className={cn(
          "h-4 w-4 text-muted-foreground transition-transform duration-200",
          open && "rotate-180",
        )}
      />
    </button>
  );
});
SelectTrigger.displayName = "SelectTrigger";

function SelectValue({
  placeholder,
  children,
}: {
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const { value, labelFor } = React.useContext(SelectContext);
  if (!value) return <span>{placeholder}</span>;
  // Caller can override the rendered label via children; otherwise show the
  // label registered by the matching SelectItem.
  return <span>{children ?? labelFor(value) ?? placeholder}</span>;
}

function SelectContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { open, setOpen, listboxId, triggerRef } = React.useContext(SelectContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({ top: 0, left: 0, minWidth: 0 });

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current || !ref.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuHeight = ref.current.offsetHeight;
    const gap = 4;

    let top = triggerRect.bottom + gap;
    // Flip above trigger if the popup overflows the viewport bottom
    if (top + menuHeight > window.innerHeight) {
      top = triggerRect.top - menuHeight - gap;
    }
    // Constrain to viewport top if the flipped popup also overflows
    if (top < 8) {
      top = 8;
    }

    setPosition({ top, left: triggerRect.left, minWidth: triggerRect.width });
  }, [open, triggerRef]);

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
      // Scrolling the bounded option list INSIDE the popup must not dismiss
      // it — only outside scroll invalidates the fixed anchored position.
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

  // Portal to <body> so overflow-hidden/transformed ancestors can neither clip
  // the popup nor re-root its position:fixed. Unlike DropdownMenuContent, the
  // portal stays mounted while closed (`hidden`): SelectItem effects register
  // the value→label map that SelectValue reads on the closed trigger.
  return createPortal(
    <div
      ref={ref}
      id={listboxId}
      role="listbox"
      hidden={!open}
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        minWidth: position.minWidth,
      }}
      className={cn(
        // z-[60]: many Selects sit inside DialogContent whose overlay is z-50,
        // so the portaled popup must paint above the dialog (RoleCombobox precedent).
        "z-[60] max-h-64 overflow-auto rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] border border-border/80 bg-popover/96 p-1.5 text-popover-foreground shadow-panel backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

type SelectItemProps = {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onClick">;

function SelectItem({
  value,
  children,
  className,
  disabled = false,
  ...rest
}: SelectItemProps) {
  const {
    value: selectedValue,
    onValueChange,
    setOpen,
    registerItem,
    unregisterItem,
  } = React.useContext(SelectContext);

  React.useEffect(() => {
    registerItem(value, children);
    return () => unregisterItem(value);
  }, [value, children, registerItem, unregisterItem]);

  return (
    <div
      {...rest}
      role="option"
      aria-selected={selectedValue === value}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.2rem))] px-3 py-2 text-sm outline-none transition-[background-color,color,transform] duration-150",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-accent hover:text-accent-foreground",
        selectedValue === value &&
          "bg-accent text-accent-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_35%,transparent)]",
        className,
      )}
      onClick={() => {
        // Disabled items must not commit a value or close the popup; the
        // operator can still arrow over them but selection is a no-op.
        if (disabled) return;
        onValueChange(value);
        setOpen(false);
      }}
    >
      {children}
    </div>
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
