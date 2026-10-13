// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { m } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useMotionTokens, useReducedMotionPreference } from "../motion/reduced-motion";
import { menuMotion } from "../motion/variants";
import { Icon } from "./Icon";
import { nextRovingIndex } from "./roving-focus";

const itemsOf = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];

export interface RadioMenuItem<T extends string> {
  value: T;
  label: string;
}

interface RadioMenuButtonProps<T extends string> {
  /** The button's accessible name, which should say the current choice. */
  buttonLabel: string;
  menuLabel: string;
  items: readonly RadioMenuItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** A line under the items, read as the menu's description. */
  footer?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A button that opens a single-choice menu (the ARIA menu button pattern).
 * Not a native <select>: its OS popup can take focus from the tray popover and hide it.
 * Focus moves into the menu on open and back to the button on close; Escape
 * is marked handled so the popover stays open.
 */
export function RadioMenuButton<T extends string>({ buttonLabel, menuLabel, items, value, onValueChange, footer, className = "", children }: RadioMenuButtonProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const footerId = useId();
  const recipe = menuMotion(useMotionTokens(), useReducedMotionPreference());

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const checked = Math.max(
      0,
      items.findIndex((item) => item.value === value),
    );
    itemsOf(menuRef.current)[checked]?.focus();
  }, [open, items, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" || open) return;
    event.preventDefault();
    setOpen(true);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const all = itemsOf(menuRef.current);
    const next = nextRovingIndex(event.key, all.indexOf(event.target as HTMLElement), all.length);
    if (next === null) return;
    event.preventDefault();
    all[next]?.focus();
  };

  return (
    <div ref={wrapRef} className="bp-menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
      >
        {children}
      </button>
      {open ? (
        <m.div className="bp-menu" initial={recipe.initial} animate={recipe.animate}>
          <div ref={menuRef} id={menuId} role="menu" aria-label={menuLabel} aria-describedby={footer ? footerId : undefined} onKeyDown={onMenuKeyDown}>
            {items.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={item.value === value}
                tabIndex={-1}
                className="bp-menu-item"
                onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
                onClick={() => {
                  onValueChange(item.value);
                  close(true);
                }}
              >
                <span className="bp-menu-check">{item.value === value ? <Icon name="check" /> : null}</span>
                {item.label}
              </button>
            ))}
          </div>
          {footer ? (
            <p id={footerId} className="bp-menu-note">
              {footer}
            </p>
          ) : null}
        </m.div>
      ) : null}
    </div>
  );
}
