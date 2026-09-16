// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] text-sm font-semibold tracking-[-0.01em] transition-[transform,background-color,border-color,color,box-shadow,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-glow hover:bg-primary/92",
        destructive:
          "bg-destructive text-destructive-foreground shadow-soft hover:bg-destructive/92",
        outline:
          "border border-border/75 bg-card/85 text-foreground shadow-soft hover:border-primary/30 hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-soft hover:bg-secondary/82",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        surface:
          "border border-border/60 bg-[color:var(--color-surface-1)] text-foreground shadow-soft hover:border-primary/30 hover:bg-[color:var(--color-surface-2)]",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-8 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] px-3 text-xs",
        lg: "h-10 rounded-[min(var(--radius-cap),calc(var(--radius-md)+0.1rem))] px-5 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
