// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setPromptsHidden, usePromptsHidden } from "../hooks/use-hide-prompts";

export function HidePromptsToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const hidden = usePromptsHidden();
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={hidden}
      title={t("sessions.hidePrompts.hint")}
      onClick={() => setPromptsHidden(!hidden)}
      className={cn(hidden && "border-foreground/35 bg-accent text-foreground", className)}
    >
      <EyeOff aria-hidden />
      {t("sessions.hidePrompts.label")}
    </Button>
  );
}
