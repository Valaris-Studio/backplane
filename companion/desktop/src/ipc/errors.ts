// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { DaemonError } from "./bindings";

/** Stable contract-A codes the UI branches on; the daemon may add more. */
export const DAEMON_ERROR_CODES = [
  "not_connected",
  "already_connected",
  "no_matching_board",
  "ambiguous_repo",
  "auto_match_disabled",
  "not_a_directory",
  "not_a_repository",
  "invalid_request",
  "not_found",
  "conflict",
  "server_unreachable",
  "server_rejected",
  "unauthorized_device",
  "pairing_pending",
  "pairing_persisting",
  "pairing_expired",
  "pairing_denied",
  "pairing_failed",
  "internal",
] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

/**
 * Everything a daemon call can fail with, as one union: the Rust DaemonError
 * variants plus `ipc`, for rejections from the IPC layer itself (a command
 * without a capability grant, an unknown command).
 */
export type CompanionError =
  | Exclude<DaemonError, { kind: "api" }>
  | { kind: "api"; status: number; code: DaemonErrorCode | (string & {}); message: string; detail: unknown }
  | { kind: "ipc"; message: string };

function unrecognised(): CompanionError {
  return { kind: "ipc", message: "unrecognised IPC error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toCompanionError(rejection: unknown): CompanionError {
  if (typeof rejection === "string") return { kind: "ipc", message: rejection };
  if (rejection instanceof Error) return { kind: "ipc", message: rejection.message };
  if (!isRecord(rejection)) return unrecognised();

  const { kind, reason, status, code, message, detail, limit_bytes: limitBytes } = rejection;
  switch (kind) {
    case "unreachable":
      return typeof reason === "string" ? { kind, reason } : unrecognised();
    case "api":
      return typeof status === "number" && typeof code === "string" && typeof message === "string"
        ? { kind, status, code, message, detail: detail ?? null }
        : unrecognised();
    case "protocol":
    case "invalid_input":
    case "local":
      return typeof message === "string" ? { kind, message } : unrecognised();
    case "timeout":
      return { kind };
    case "response_too_large":
      return typeof limitBytes === "number" ? { kind, limit_bytes: limitBytes } : unrecognised();
    default:
      return unrecognised();
  }
}

export function hasErrorCode(error: CompanionError, code: DaemonErrorCode): boolean {
  return error.kind === "api" && error.code === code;
}
