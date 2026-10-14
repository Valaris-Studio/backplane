// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { hasErrorCode, toCompanionError } from "./errors";

describe("toCompanionError", () => {
  it("keeps a daemon api error with its contract code and detail", () => {
    const rejection = {
      kind: "api",
      status: 502,
      code: "server_rejected",
      message: "Backplane refused",
      detail: { status: 403, error_code: "forbidden" },
    };
    expect(toCompanionError(rejection)).toEqual(rejection);
  });

  it("keeps the unreachable reason", () => {
    expect(toCompanionError({ kind: "unreachable", reason: "control_file_missing" })).toEqual({
      kind: "unreachable",
      reason: "control_file_missing",
    });
  });

  it("keeps timeout, protocol and invalid_input variants", () => {
    expect(toCompanionError({ kind: "timeout" })).toEqual({ kind: "timeout" });
    expect(toCompanionError({ kind: "protocol", message: "bad body" })).toEqual({ kind: "protocol", message: "bad body" });
    expect(toCompanionError({ kind: "invalid_input", message: "too long" })).toEqual({
      kind: "invalid_input",
      message: "too long",
    });
  });

  it("keeps the size cap of an oversized daemon response", () => {
    expect(toCompanionError({ kind: "response_too_large", limit_bytes: 8388608 })).toEqual({
      kind: "response_too_large",
      limit_bytes: 8388608,
    });
  });

  it("rejects an oversized-response error without its limit", () => {
    expect(toCompanionError({ kind: "response_too_large" })).toEqual({ kind: "ipc", message: "unrecognised IPC error" });
  });

  it("maps a string rejection from the IPC layer to an ipc error", () => {
    expect(toCompanionError("status not allowed. Permissions associated with this command: allow-status")).toEqual({
      kind: "ipc",
      message: "status not allowed. Permissions associated with this command: allow-status",
    });
  });

  it("maps a thrown Error to an ipc error with its message", () => {
    expect(toCompanionError(new Error("invoke failed"))).toEqual({ kind: "ipc", message: "invoke failed" });
  });

  it("rejects a lookalike object with an unknown kind", () => {
    expect(toCompanionError({ kind: "exploded", message: "x" })).toEqual({ kind: "ipc", message: "unrecognised IPC error" });
  });

  it("rejects an api error missing its code", () => {
    expect(toCompanionError({ kind: "api", status: 500, message: "boom" })).toEqual({
      kind: "ipc",
      message: "unrecognised IPC error",
    });
  });

  it("maps null and undefined without throwing", () => {
    expect(toCompanionError(null)).toEqual({ kind: "ipc", message: "unrecognised IPC error" });
    expect(toCompanionError(undefined)).toEqual({ kind: "ipc", message: "unrecognised IPC error" });
  });
});

describe("hasErrorCode", () => {
  it("matches an api error by contract code", () => {
    const error = toCompanionError({ kind: "api", status: 409, code: "not_connected", message: "m", detail: null });
    expect(hasErrorCode(error, "not_connected")).toBe(true);
    expect(hasErrorCode(error, "conflict")).toBe(false);
  });

  it("never matches a non-api error", () => {
    expect(hasErrorCode({ kind: "timeout" }, "internal")).toBe(false);
  });
});
