// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { MessageCircleWarning } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface HonestRemarkProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function HonestRemark({ title, children, className }: HonestRemarkProps) {
  return (
    <CalloutShell
      variant="honest"
      icon={MessageCircleWarning}
      title={title}
      colorClass="border-slate-400/50 text-slate-700 dark:border-slate-500/50 dark:text-slate-200"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
