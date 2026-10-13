// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ComponentPropsWithRef } from "react";

/** A native select styled as DK-0's channel picker; name it with aria-label or a <label>. */
export function Select({ className = "", ...rest }: ComponentPropsWithRef<"select">) {
  return <select {...rest} className={`bp-select ${className}`} />;
}
