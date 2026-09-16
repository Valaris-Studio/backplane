// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Info } from "lucide-react";
import { RichTooltip } from "@/components/ui/rich-tooltip";

// Shared label for kind-editor param fields. Mirrors LlmEditor's local
// LabelWithTooltip: a `<label>` (or visual `<span>` for widgets that can't
// take an htmlFor association) with an optional info-icon RichTooltip pulling
// content from `ui.tooltips.<tooltipKey>`. Keeps the 18 editors from each
// re-implementing the same accessible trigger.
export function FieldLabel({
  htmlFor,
  children,
  tooltipKey,
  as = "label",
}: {
  htmlFor?: string;
  children: React.ReactNode;
  tooltipKey?: string;
  as?: "label" | "span";
}) {
  const className =
    "mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground";
  const inner = (
    <>
      <span>{children}</span>
      {tooltipKey ? (
        <RichTooltip i18nKey={tooltipKey} side="top">
          <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
        </RichTooltip>
      ) : null}
    </>
  );
  if (as === "span") {
    return <span className={className}>{inner}</span>;
  }
  return (
    <label htmlFor={htmlFor} className={className}>
      {inner}
    </label>
  );
}
