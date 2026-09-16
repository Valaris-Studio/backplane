// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { shouldRetry } from "../should-retry";
import { ApiError } from "../api-error";

describe("shouldRetry", () => {
  // During an outage the backend sheds load with 429/5xx; retrying an already
  // failing request only amplifies the storm that took the DB down.
  it("never retries HTTP 429", () => {
    expect(shouldRetry(0, new ApiError("rate limited", 429))).toBe(false);
    expect(shouldRetry(5, new ApiError("rate limited", 429))).toBe(false);
  });

  it("never retries any 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetry(0, new ApiError("server error", status))).toBe(false);
    }
  });

  // Network errors surface as ApiError with status 0 (no response). A dropped
  // connection is worth exactly one more attempt.
  it("retries a network error once, then stops", () => {
    const networkError = new ApiError("Network Error", 0);
    expect(shouldRetry(0, networkError)).toBe(true);
    expect(shouldRetry(1, networkError)).toBe(false);
  });

  // Non-outage HTTP errors (e.g. 404) follow the default single retry so a
  // transient blip is still smoothed over.
  it("retries a 404 once, then stops", () => {
    const notFound = new ApiError("not found", 404);
    expect(shouldRetry(0, notFound)).toBe(true);
    expect(shouldRetry(1, notFound)).toBe(false);
  });

  it("retries a non-ApiError (unknown) once, then stops", () => {
    const unknown = new Error("boom");
    expect(shouldRetry(0, unknown)).toBe(true);
    expect(shouldRetry(1, unknown)).toBe(false);
  });
});
