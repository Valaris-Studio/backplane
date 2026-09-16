// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ApiError, isApiError } from "../api-error";

describe("ApiError", () => {
  it("is an Error subclass carrying status + structured detail", () => {
    const err = new ApiError("Conflict", 409, {
      code: "stale_version",
      current_version: 8,
      expected_version: 7,
    });
    // Backward-compat: existing callers read err.message and JSON.parse it.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Conflict");
    expect(err.status).toBe(409);
    expect(err.detail).toEqual({
      code: "stale_version",
      current_version: 8,
      expected_version: 7,
    });
  });

  it("isApiError narrows unknown errors", () => {
    expect(isApiError(new ApiError("x", 422))).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
    expect(isApiError("nope")).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it("isConflict / isValidation read the status", () => {
    expect(new ApiError("c", 409).isConflict()).toBe(true);
    expect(new ApiError("c", 409).isValidation()).toBe(false);
    expect(new ApiError("v", 422).isValidation()).toBe(true);
    expect(new ApiError("v", 422).isConflict()).toBe(false);
  });

  it("preserves the stable code, structured params, and raw detail", () => {
    const detail = [{ field: "body.email", type: "value_error" }];
    const context = { expectedVersion: 7, currentVersion: 8 };
    const err = new ApiError("Validation failed", 422, detail, {
      errorCode: "request_validation_error",
      errorParams: {
        issues: [{ field: "body.email", code: "value_error" }],
      },
      context,
    });

    expect(err.errorCode).toBe("request_validation_error");
    expect(err.errorParams).toEqual({
      issues: [{ field: "body.email", code: "value_error" }],
    });
    expect(err.context).toBe(context);
    expect(err.detail).toBe(detail);
  });
});
