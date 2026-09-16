// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { i18n, TFunction } from "i18next";
import { isApiError } from "./api-error";

interface ApiErrorMessageOptions {
  fallbackKey?: string;
  /** Render the server's `detail` verbatim when it is a non-empty string.
   * Opt-in per callsite: right for surfaces whose backend writes the
   * user-actionable copy into `detail` (e.g. skill-bundle validation, where
   * every failure mode shares error_code "validation_error"), wrong for
   * surfaces that want the localized catalog string. */
  preferDetail?: boolean;
}

interface LocalizableValidationFinding {
  code: string;
  field: string;
  value?: unknown;
  params?: Record<string, unknown>;
}

function hasStableCode(code: string | undefined): code is string {
  return code !== undefined && /^[a-z0-9_]+$/.test(code);
}

export function resolveApiErrorMessage(
  error: unknown,
  t: TFunction,
  i18nInstance: i18n,
  options: ApiErrorMessageOptions = {},
) {
  const fallbackKey = options.fallbackKey ?? "errors.unknown";

  if (
    options.preferDetail &&
    isApiError(error) &&
    typeof error.detail === "string" &&
    error.detail.trim() !== ""
  ) {
    return error.detail;
  }

  if (isApiError(error) && hasStableCode(error.errorCode)) {
    const translationKey = `errors.${error.errorCode}`;
    if (i18nInstance.exists(translationKey)) {
      return t(translationKey, error.errorParams);
    }
  }

  return t(fallbackKey);
}

export function resolvePipelineValidationMessage(
  finding: LocalizableValidationFinding,
  t: TFunction,
  i18nInstance: i18n,
) {
  const translationKey = `pipelineValidation.${finding.code}`;
  const params = {
    field: finding.field || "(root)",
    value: finding.value,
    ...finding.params,
  };

  return i18nInstance.exists(translationKey)
    ? t(translationKey, params)
    : t("pipelineValidation.unknown", params);
}
