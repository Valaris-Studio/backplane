// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Exported so pills that hand-roll the badge geometry (BoardLoopStatusChip is
// a <button> with its own focus ring, so it cannot BE a Badge) consume the same
// token instead of re-typing the literal. Two independent literals are how the
// column-type label silently drifted a notch larger than the loop pill.
export const BADGE_SIZE_MD = "text-[0.67rem]";
export const BADGE_SIZE_SM = "text-[0.6rem]";

const badgeVariants = cva(
  // whitespace-nowrap + shrink-0: a pill's label is a single state word or
  // count, so breaking it across lines reads as a rendering fault rather than
  // as text. Fixed in the primitive because every call site inherits the bug —
  // ColumnHeader's done-gate badge was reduced to a bare glyph to dodge it.
  // shrink-0 is the other half: nowrap alone still lets an overflowing flex row
  // squeeze a pill below its intrinsic width and clip the label. Containers
  // that hold pills wrap BETWEEN them instead.
  // The size literal deliberately lives in the `size` variant, never here, so
  // the two sizes stay mutually exclusive and a size choice cannot be
  // half-overridden by a leftover base class.
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 font-semibold uppercase tracking-[0.16em] transition-[background-color,border-color,color,box-shadow] duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/14 text-primary shadow-[inset_0_1px_0_color-mix(in_oklab,white_60%,transparent)]",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive/14 text-destructive shadow-[inset_0_1px_0_color-mix(in_oklab,white_60%,transparent)]",
        outline:
          "border-border/70 bg-transparent text-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_35%,transparent)]",
        success:
          "border-transparent bg-success/16 text-[color:var(--color-success-foreground)]",
        warning:
          "border-transparent bg-warning/22 text-[color:var(--color-warning-foreground)]",
        info:
          "border-transparent bg-info/18 text-[color:var(--color-info-foreground)]",
      },
      size: {
        md: BADGE_SIZE_MD,
        sm: BADGE_SIZE_SM,
      },
    },
    defaultVariants: {
      variant: "default",
      // md is the pre-existing base size, so every untouched call site renders
      // byte-identically to before the axis existed.
      size: "md",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
