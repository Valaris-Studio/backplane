// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-auto scroll-smooth pr-1", className)}
    {...props}
  >
    {children}
  </div>
));
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
