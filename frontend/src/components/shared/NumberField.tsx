// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Input } from "@/components/ui/input";

// A labelled numeric input. `value` stays a string and `onChange` reports the
// raw string: a half-typed "" or "-" must survive a keystroke, which coercing
// to number here would destroy.
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  step,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        step={step}
        disabled={disabled}
      />
    </div>
  );
}
