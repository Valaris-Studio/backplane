// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import axios from "axios";
import { ApiError, isApiError } from "./api-error";
import {
  isLoginAvailable,
  redirectToLogin,
  shouldRedirectToLogin,
} from "@/features/auth/redirect-to-login";

const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : "/api";

export const api = axios.create({
  baseURL,
});

// In local dev there's no IAP in front of the API, so the backend reads
// `X-User-Email` (falling back to dev@valaris.dev). Sending it explicitly keys
// requests to the AUTHENTICATED rate-limit tier (300/min) instead of the shared
// per-IP UNAUTHENTICATED tier (60/min) — the low IP tier throttles the app's
// normal first-load fan-out. Guarded to DEV so prod (behind IAP) is untouched.
if (import.meta.env.DEV) {
  api.interceptors.request.use((config) => {
    config.headers.set("X-User-Email", "dev@valaris.dev");
    return config;
  });
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const apiError = toApiError(error);
    // With an app-owned login (OIDC or local password), an auth rejection
    // carries a session-specific code. Permission 403s stay with the caller so
    // contextual errors and recovery remain available. No-op
    // behind IAP or an authenticating proxy, where sign-in happens upstream.
    if (
      shouldRedirectToLogin(apiError.status, {
        loginAvailable: isLoginAvailable(),
        errorCode: apiError.errorCode,
      })
    ) {
      redirectToLogin();
    }
    return Promise.reject(apiError);
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;

  const transportError = isRecord(error) ? error : {};
  const response = isRecord(transportError.response)
    ? transportError.response
    : {};
  const responseData = isRecord(response.data) ? response.data : {};
  const detail = responseData.detail;
  const message =
    typeof detail === "string"
      ? detail
      : detail !== undefined
        ? JSON.stringify(detail)
        : typeof transportError.message === "string"
          ? transportError.message
          : "Unknown error";
  const status = typeof response.status === "number" ? response.status : 0;
  const errorCode =
    typeof responseData.error_code === "string"
      ? responseData.error_code
      : undefined;
  const errorParams = isRecord(responseData.error_params)
    ? responseData.error_params
    : {};
  const context = responseData.context;

  return new ApiError(message, status, detail, {
    errorCode,
    errorParams,
    context,
  });
}
