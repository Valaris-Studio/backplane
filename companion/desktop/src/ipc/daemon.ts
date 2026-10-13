// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { toCompanionError, type CompanionError } from "./errors";

export type DaemonResult<T> = { ok: true; value: T } | { ok: false; error: CompanionError };

/** Runs one generated command and never throws: failures come back typed. */
export async function callDaemon<T>(invocation: () => Promise<T>): Promise<DaemonResult<T>> {
  try {
    return { ok: true, value: await invocation() };
  } catch (rejection) {
    return { ok: false, error: toCompanionError(rejection) };
  }
}
