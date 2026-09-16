// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { buildEntityLink, type EntityRef } from "@/lib/entity-link";

/**
 * Renders a reference to a platform entity (card, execution, note, agent,
 * board, PR) as a clickable link — the house "link anything we mention" rule.
 * Internal targets use the router; external (PR) targets open in a new tab.
 * If the reference can't be resolved to a route, falls back to plain text so a
 * partial reference never produces a dangling link.
 */
export function EntityLink({
  className,
  children,
  ...ref
}: EntityRef & { className?: string; children: ReactNode }) {
  const resolved = buildEntityLink(ref);
  const linkClass = className ?? "text-primary hover:underline";

  if (!resolved) {
    return <span className={className}>{children}</span>;
  }
  if (resolved.external) {
    return (
      <a
        href={resolved.href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        {children}
      </a>
    );
  }
  return (
    <Link to={resolved.href} className={linkClass}>
      {children}
    </Link>
  );
}
