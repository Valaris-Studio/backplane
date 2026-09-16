// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Clock } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface FutureStateProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function FutureState({ title, children, className }: FutureStateProps) {
  return (
    <CalloutShell
      variant="future"
      icon={Clock}
      title={title}
      colorClass="border-indigo-400/60 text-indigo-900 dark:border-indigo-500/55 dark:text-indigo-100"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
