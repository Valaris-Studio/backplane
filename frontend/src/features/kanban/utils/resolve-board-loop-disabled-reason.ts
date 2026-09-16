// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import { formatNumber, formatUsd } from "@/lib/format";

interface BoardLoopDisabledState {
  disabled_reason: string | null;
  disabled_reason_code?: string | null;
  disabled_reason_params?: Record<string, unknown> | null;
  disabled_diagnostic?: string | null;
}

type ReasonCode =
  | "max_iterations_reached"
  | "budget_exhausted"
  | "consecutive_failures";

const knownReasonCodes = new Set<string>([
  "max_iterations_reached",
  "budget_exhausted",
  "consecutive_failures",
] satisfies ReasonCode[]);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : null;
}

function hasExactKeys(
  params: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(params);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(params, key))
  );
}

function localizedReason(
  code: ReasonCode,
  params: Record<string, unknown>,
  t: TFunction,
): string | null {
  if (code === "max_iterations_reached") {
    if (!hasExactKeys(params, ["max_iterations"])) return null;
    const maxIterations = positiveInteger(params.max_iterations);
    if (maxIterations === null) return null;
    const variant = maxIterations === 1 ? "one" : "other";
    return t(`boardLoop.reasons.max_iterations_reached.${variant}`, {
      replace: { maxIterations: formatNumber(maxIterations) },
    });
  }

  if (code === "budget_exhausted") {
    if (!hasExactKeys(params, ["spent_usd", "budget_usd"])) return null;
    const spentUsd = finiteNumber(params.spent_usd);
    const budgetUsd = finiteNumber(params.budget_usd);
    if (
      spentUsd === null ||
      budgetUsd === null ||
      spentUsd < 0 ||
      budgetUsd <= 0 ||
      spentUsd < budgetUsd
    ) {
      return null;
    }
    return t("boardLoop.reasons.budget_exhausted", {
      replace: {
        spentUsd: formatUsd(spentUsd),
        budgetUsd: formatUsd(budgetUsd),
      },
    });
  }

  if (!hasExactKeys(params, ["count"])) return null;
  const count = positiveInteger(params.count);
  if (count === null) return null;
  const variant = count === 1 ? "one" : "other";
  return t(`boardLoop.reasons.consecutive_failures.${variant}`, {
    replace: { count: formatNumber(count) },
  });
}

export function resolveBoardLoopDisabledReason(
  state: BoardLoopDisabledState,
  t: TFunction,
): string | null {
  const { disabled_reason_code: code, disabled_reason_params: params } = state;
  if (!code || !knownReasonCodes.has(code) || !params) {
    return state.disabled_reason;
  }

  return localizedReason(code as ReasonCode, params, t) ?? state.disabled_reason;
}

export function resolveBoardLoopDisabledDiagnostic(
  state: BoardLoopDisabledState,
  visibleReason: string | null,
): string | null {
  const diagnostic = state.disabled_diagnostic;
  if (!diagnostic || diagnostic === visibleReason) return null;
  return diagnostic;
}
