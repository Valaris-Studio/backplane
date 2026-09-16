// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface ProTipProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function ProTip({ title, children, className }: ProTipProps) {
  return (
    <CalloutShell
      variant="protip"
      icon={Sparkles}
      title={title}
      colorClass="border-emerald-400/60 text-emerald-900 dark:border-emerald-500/55 dark:text-emerald-100"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
