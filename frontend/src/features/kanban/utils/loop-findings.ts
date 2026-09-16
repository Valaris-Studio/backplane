// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// PUT /loop 422 detail → inline findings. Shared by the raw dialog and the
// bound view's guardrails editor, which write the same columns and must
// render the same server complaint the same way.

export interface ValidationFinding {
  field: string;
  message: string;
}

export function parseFindings(detail: unknown): ValidationFinding[] {
  if (!Array.isArray(detail)) {
    return [{ field: "", message: String(detail ?? "") }];
  }
  return detail.map((raw) => {
    const finding = raw as Record<string, unknown>;
    return {
      field: typeof finding.field === "string" ? finding.field : "",
      message: typeof finding.message === "string" ? finding.message : "",
    };
  });
}

export function formatFinding(finding: ValidationFinding): string {
  return finding.field ? `${finding.field}: ${finding.message}` : finding.message;
}
