// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@/lib/utils";

// Notion-style always-editable title: the input IS the visible heading — no
// box, no edit-mode switch. Swapping an <h2> for an input on click would drop
// the caret where the user clicked and complicate focus/accessibility; a
// borderless input gets the heading look with none of that. Typography
// mirrors SheetTitle so the title reads as the sheet's h2.
const TitleInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="text"
    className={cn(
      "w-full bg-transparent text-2xl font-bold tracking-[-0.04em] text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TitleInput.displayName = "TitleInput";

export { TitleInput };
