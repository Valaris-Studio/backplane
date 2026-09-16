// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";
import type { ToolKind } from "./data";

const KIND_STYLES: Record<ToolKind, string> = {
  read: "border-sky-500/50 text-sky-700 dark:text-sky-300",
  write: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  composite: "border-violet-500/50 text-violet-700 dark:text-violet-300",
};

export function ToolKindBadge({ kind }: { kind: ToolKind }) {
  return (
    <span
      data-doc-technical
      className={cn(
        "rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em]",
        KIND_STYLES[kind],
      )}
    >
      {kind}
    </span>
  );
}
