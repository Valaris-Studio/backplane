// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface ImportantNoteProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function ImportantNote({ title, children, className }: ImportantNoteProps) {
  return (
    <CalloutShell
      variant="important"
      icon={AlertCircle}
      title={title}
      colorClass="border-amber-400/60 text-amber-900 dark:border-amber-500/55 dark:text-amber-100"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
