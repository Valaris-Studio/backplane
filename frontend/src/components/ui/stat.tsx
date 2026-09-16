// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statValueVariants = cva("font-bold tabular-nums leading-tight", {
  variants: {
    size: {
      sm: "text-lg",
      md: "text-2xl",
      lg: "text-3xl",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface StatProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof statValueVariants> {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ReactNode;
}

// A value+label cell. Sizes map to the recurring text-lg / text-2xl / text-3xl
// stat treatments scattered across the analytics views.
const Stat = React.forwardRef<HTMLDivElement, StatProps>(
  ({ label, value, icon, size, className, ...props }, ref) => (
    <div ref={ref} className={cn("text-center", className)} {...props}>
      {icon && (
        <span className="mb-1 inline-flex items-center justify-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
          {icon}
        </span>
      )}
      <p className={statValueVariants({ size })}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  ),
);
Stat.displayName = "Stat";

export { Stat, statValueVariants };
