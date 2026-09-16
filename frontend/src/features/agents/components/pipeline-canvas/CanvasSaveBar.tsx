// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { RotateCcw, Save, AlertCircle } from "lucide-react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CanvasSaveBarProps {
  dirty: boolean;
  saving: boolean;
  errorCount: number;
  onSave: () => void;
  onDiscard: () => void;
}

// Floating dirty/save/discard bar for the pipeline canvas. Slides up when the
// draft diverges from the server config; hidden otherwise.
export function CanvasSaveBar({
  dirty,
  saving,
  errorCount,
  onSave,
  onDiscard,
}: CanvasSaveBarProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  if (!dirty) return null;

  return (
    <motion.div
      initial={reduce ? false : { y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={reduce ? undefined : { y: 24, opacity: 0 }}
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-[var(--radius-md)] border border-border/70",
        "bg-card/95 px-3 py-2 shadow-soft backdrop-blur",
      )}
      data-testid="canvas-save-bar"
    >
      {errorCount > 0 ? (
        <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          {t("pipelineGraph.canvas.errorCount", { count: errorCount })}
        </span>
      ) : (
        <span className="text-xs font-medium text-muted-foreground">
          {t("pipelineGraph.canvas.unsaved")}
        </span>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onDiscard}
          disabled={saving}
          data-testid="canvas-discard"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("pipelineGraph.canvas.discard")}
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || errorCount > 0}
          data-testid="canvas-save"
        >
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {saving ? t("common.saving") : t("pipelineGraph.canvas.save")}
        </Button>
      </div>
    </motion.div>
  );
}
