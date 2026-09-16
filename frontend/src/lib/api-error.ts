// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApiErrorMetadata {
  errorCode?: string;
  errorParams?: Record<string, unknown>;
  context?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly errorCode?: string;
  readonly errorParams: Record<string, unknown>;
  readonly context: unknown;

  constructor(
    message: string,
    status: number,
    detail?: unknown,
    metadata: ApiErrorMetadata = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.errorCode = metadata.errorCode;
    this.errorParams = metadata.errorParams ?? {};
    this.context = metadata.context ?? null;
    // Restore the prototype chain for `instanceof` under transpiled targets.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  isConflict(): boolean {
    return this.status === 409;
  }

  isValidation(): boolean {
    return this.status === 422;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
