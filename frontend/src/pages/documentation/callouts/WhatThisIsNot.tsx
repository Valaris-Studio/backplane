// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { CircleSlash } from "lucide-react";
import { CalloutShell } from "./CalloutShell";

interface WhatThisIsNotProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function WhatThisIsNot({ title, children, className }: WhatThisIsNotProps) {
  return (
    <CalloutShell
      variant="what-is-not"
      icon={CircleSlash}
      title={title}
      colorClass="border-rose-400/60 text-rose-900 dark:border-rose-500/55 dark:text-rose-100"
      className={className}
    >
      {children}
    </CalloutShell>
  );
}
