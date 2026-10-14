// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

export type PillTone = "neutral" | "success" | "warning" | "error";

export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className="bp-pill" data-tone={tone}>
      {children}
    </span>
  );
}
