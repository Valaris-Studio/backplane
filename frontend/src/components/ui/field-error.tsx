// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldErrorProps {
  messages?: string | string[];
  className?: string;
  id?: string;
}

// Inline form-validation messages. Renders nothing when empty so callers can
// pass it unconditionally. role=alert surfaces new errors to screen readers.
function FieldError({ messages, className, id }: FieldErrorProps) {
  const list = React.useMemo(
    () => (Array.isArray(messages) ? messages : messages ? [messages] : []),
    [messages],
  );
  if (list.length === 0) return null;

  return (
    <ul
      id={id}
      role="alert"
      className={cn("mt-1 space-y-0.5 text-xs text-destructive", className)}
    >
      {list.map((message, idx) => (
        <li key={`${message}-${idx}`}>{message}</li>
      ))}
    </ul>
  );
}

export { FieldError };
