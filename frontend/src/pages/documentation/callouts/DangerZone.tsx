// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Shield } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface DangerZoneProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function DangerZone({ title, children, className }: DangerZoneProps) {
  return (
    <CalloutShell
      variant="danger"
      icon={Shield}
      title={title}
      colorClass="border-red-500/65 text-red-900 dark:border-red-500/60 dark:text-red-100"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
