// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface InfoTooltipProps {
  text: string;
  side?: "top" | "bottom" | "left" | "right";
}

export function InfoTooltip({ text, side = "right" }: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <Info className="h-3.5 w-3.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent side={side} variant="info">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
