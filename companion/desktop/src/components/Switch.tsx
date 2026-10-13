// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ComponentPropsWithRef } from "react";

interface SwitchProps extends Omit<ComponentPropsWithRef<"button">, "onChange" | "type" | "role" | "aria-checked"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The accessible name, e.g. "Capture sessions in backplane". Omit only when aria-labelledby is set. */
  label?: string;
}

export function Switch({ checked, onCheckedChange, label, className = "", ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`bp-switch ${className}`}
      onClick={() => onCheckedChange(!checked)}
    />
  );
}
