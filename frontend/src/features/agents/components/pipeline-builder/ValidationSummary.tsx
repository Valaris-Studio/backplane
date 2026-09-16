// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { resolvePipelineValidationMessage } from "@/lib/localized-errors";
import type { PipelineValidationError } from "../../api/pipelineConfig";

// Findings may carry an optional severity; absent severity means "error"
// (the historical default). Warnings are advisory and never block the save.
type Finding = PipelineValidationError & { severity?: string };

interface ValidationSummaryProps {
  errors: Finding[];
}

export function ValidationSummary({ errors }: ValidationSummaryProps) {
  const { t, i18n } = useTranslation();
  const blocking = errors.filter((e) => (e.severity ?? "error") === "error");
  const warnings = errors.filter((e) => e.severity === "warning");
  if (blocking.length === 0 && warnings.length === 0) return null;

  return (
    <div className="space-y-2">
      {blocking.length > 0 && (
        <div
          role="alert"
          data-testid="validation-summary"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t("pipelineBuilder.validationErrors")} ({blocking.length})
          </div>
          <ul className="space-y-1 text-xs">
            {blocking.map((err, idx) => (
              <li key={`${err.code}-${idx}`} className="text-destructive/90">
                <code className="mr-2 rounded bg-destructive/20 px-1 py-0.5 text-[0.65rem]">
                  {err.field || "(root)"}
                </code>
                {resolvePipelineValidationMessage(err, t, i18n)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div
          role="status"
          data-testid="validation-warnings"
          className="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10 p-3"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-warning-foreground)]">
            <AlertTriangle className="h-4 w-4" />
            {t("pipelineBuilder.validationWarnings")} ({warnings.length})
          </div>
          <ul className="space-y-1 text-xs">
            {warnings.map((err, idx) => (
              <li
                key={`${err.code}-${idx}`}
                className="text-[color:var(--color-warning-foreground)]/90"
              >
                <code className="mr-2 rounded bg-[color:var(--color-warning)]/20 px-1 py-0.5 text-[0.65rem]">
                  {err.field || "(root)"}
                </code>
                {resolvePipelineValidationMessage(err, t, i18n)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
