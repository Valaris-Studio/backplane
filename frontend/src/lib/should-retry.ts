// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isApiError } from "./api-error";

// React Query `retry` predicate. During an outage the backend sheds load with
// 429 (rate limit) and 5xx; retrying those requests only amplifies the storm
// that took the DB down on 2026-07-23. Everything else (network drop, 4xx)
// keeps the prior single-retry behavior.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.status === 429 || error.status >= 500) return false;
  }
  return failureCount < 1;
}
