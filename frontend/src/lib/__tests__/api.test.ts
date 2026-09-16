// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { toApiError } from "../api";

describe("toApiError", () => {
  it("normalizes the backend error envelope without dropping diagnostics", () => {
    const detail = [{ field: "body.email", type: "value_error" }];
    const context = { expected_version: 7, current_version: 8 };
    const error = toApiError({
      message: "Request failed with status code 422",
      response: {
        status: 422,
        data: {
          detail,
          error_code: "request_validation_error",
          error_params: {
            issues: [{ field: "body.email", code: "value_error" }],
          },
          context,
        },
      },
    });

    expect(error.status).toBe(422);
    expect(error.errorCode).toBe("request_validation_error");
    expect(error.errorParams).toEqual({
      issues: [{ field: "body.email", code: "value_error" }],
    });
    expect(error.detail).toBe(detail);
    expect(error.context).toBe(context);
    expect(JSON.parse(error.message)).toEqual(detail);
  });
});
