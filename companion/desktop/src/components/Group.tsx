// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ComponentPropsWithRef, ReactNode } from "react";

/** An inset grouped list (the macOS settings look). */
export function Group({ label, className = "", children, ...rest }: ComponentPropsWithRef<"ul"> & { label?: string }) {
  return (
    <ul {...rest} aria-label={label} className={`bp-group ${className}`}>
      {children}
    </ul>
  );
}

export function Row({ className = "", children, ...rest }: ComponentPropsWithRef<"li">) {
  return (
    <li {...rest} className={`bp-row ${className}`}>
      {children}
    </li>
  );
}

/** The row's growing text column: a title with an optional muted sub-line. */
export function RowText({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <span className="bp-row-text">
      {title}
      {sub ? <span className="bp-row-sub">{sub}</span> : null}
    </span>
  );
}

export function RowValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="bp-row-value" title={title}>
      {children}
    </span>
  );
}
