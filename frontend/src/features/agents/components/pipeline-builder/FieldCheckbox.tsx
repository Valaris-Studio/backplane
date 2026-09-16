// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { RichTooltip } from "@/components/ui/rich-tooltip";

interface FieldCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id?: string;
  tooltipKey?: string;
}

// Builder-specific checkbox row: the shared <Checkbox> primitive plus an
// optional RichTooltip help affordance the primitive doesn't carry.
export function FieldCheckbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  tooltipKey,
}: FieldCheckboxProps) {
  return (
    <div className="flex items-start gap-1.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        label={label}
        description={description}
        disabled={disabled}
      />
      {tooltipKey && (
        <RichTooltip i18nKey={tooltipKey} side="top">
          <Info className="mt-1 h-3 w-3 text-muted-foreground/70" aria-hidden />
        </RichTooltip>
      )}
    </div>
  );
}
