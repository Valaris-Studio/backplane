// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useLayoutEffect, useRef } from "react";

import { tabStopIndex, useRovingSelection } from "./roving-focus";

interface TabBase<T extends string> {
  id: T;
  label: string;
  /** A warning dot, e.g. an agent that needs attention. */
  dot?: boolean;
  dotLabel?: string;
}

/** A count badge (hidden at 0) always comes with what it means, read after the label. */
export type TabItem<T extends string = string> = TabBase<T> &
  ({ count: number; countLabel: string } | { count?: undefined; countLabel?: undefined });

interface TabsProps<T extends string> {
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (id: T) => void;
  /** Tab ids are `${idPrefix}-${item.id}`, so a panel can be aria-labelledby its tab. */
  idPrefix: string;
  panelId: string;
  variant?: "main" | "sub";
}

/**
 * The macOS segmented tab bar: the selected tab is the one tab stop, arrows
 * move and select, and a thumb slides under the selection (a CSS transition
 * on the tokens, instant under reduced motion).
 */
export function Tabs<T extends string>({ label, items, value, onValueChange, idPrefix, panelId, variant = "main" }: TabsProps<T>) {
  const select = (id: T) => {
    if (id !== value) onValueChange(id);
  };
  const ids = items.map((item) => item.id);
  const roving = useRovingSelection(ids, select, '[role="tab"]');
  const tabStop = tabStopIndex(ids, value);
  const listRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const thumb = thumbRef.current;
    if (!list || !thumb) return;
    const place = () => {
      const selected = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!selected) return;
      // CSSOM writes, which the style-src 'self' CSP allows.
      thumb.style.width = `${selected.offsetWidth}px`;
      thumb.style.transform = `translateX(${selected.offsetLeft - 2}px)`;
    };
    place();
    // The first placement must not slide in from the left edge.
    const frame = requestAnimationFrame(() => thumb.setAttribute("data-ready", "true"));
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [value, items]);

  return (
    <div ref={listRef} role="tablist" aria-label={label} className="bp-tabs" data-variant={variant} onKeyDown={roving.onKeyDown}>
      <span ref={thumbRef} className="bp-tab-thumb" data-tab-thumb aria-hidden="true" />
      {items.map((item, index) => {
        const selected = item.id === value;
        const showCount = typeof item.count === "number" && item.count > 0;
        const extras = [showCount ? item.countLabel : undefined, item.dot ? item.dotLabel : undefined].filter(Boolean);
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.id}`}
            aria-controls={panelId}
            aria-selected={selected}
            tabIndex={index === tabStop ? 0 : -1}
            aria-label={extras.length > 0 ? [item.label, ...extras].join(", ") : undefined}
            className="bp-tab"
            onClick={() => select(item.id)}
          >
            {item.label}
            {showCount ? (
              <span className="bp-tab-count" data-count aria-hidden="true">
                {item.count}
              </span>
            ) : null}
            {item.dot ? <span className="bp-tab-dot" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
