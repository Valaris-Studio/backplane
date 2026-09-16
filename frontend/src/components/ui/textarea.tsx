// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-input/85 bg-[color:var(--color-surface-1)] px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,white_40%,transparent)] transition-[border-color,background-color,box-shadow,color] duration-200 placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
