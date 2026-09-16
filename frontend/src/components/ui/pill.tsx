// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The shared "tag chip" shape used across list views (members, git repos,
// channels). Tint is supplied either via a named `tint` variant or by passing
// a bespoke `className` (e.g. data-color tokens that don't fit a fixed enum).
const pillVariants = cva(
  "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]",
  {
    variants: {
      tint: {
        none: "",
        primary: "bg-primary/14 text-primary",
        muted: "bg-muted text-muted-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        info: "bg-info/16 text-[color:var(--color-info-foreground)]",
        success: "bg-success/16 text-[color:var(--color-success-foreground)]",
        warning: "bg-warning/24 text-[color:var(--color-warning-foreground)]",
      },
    },
    defaultVariants: {
      tint: "none",
    },
  },
);

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {}

const Pill = React.forwardRef<HTMLSpanElement, PillProps>(
  ({ className, tint, ...props }, ref) => (
    <span ref={ref} className={cn(pillVariants({ tint }), className)} {...props} />
  ),
);
Pill.displayName = "Pill";

export { Pill, pillVariants };
