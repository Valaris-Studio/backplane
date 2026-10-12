// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { resolveMediaSrc } from "@/lib/media-src";

interface MediaUploadUrlResponse {
  upload_url: string;
  public_url: string;
}

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** The PUT of the bytes failed after the backend minted an upload URL. */
export class UploadTransferError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Upload transfer failed with HTTP ${status}`);
    this.name = "UploadTransferError";
    this.status = status;
  }
}

export class FileTooLargeError extends Error {
  constructor() {
    super("FILE_TOO_LARGE");
    this.name = "FileTooLargeError";
  }
}

/**
 * Mints an upload URL, PUTs the bytes, and returns the backend's stable media
 * path exactly as given — relative, so stored content never pins an origin.
 */
export async function uploadWorkspaceMedia(
  workspaceSlug: string,
  file: File,
  contentType: string,
): Promise<string> {
  const { data } = await api.post<MediaUploadUrlResponse>(
    `/workspaces/${workspaceSlug}/media/upload-url`,
    { filename: file.name, content_type: contentType },
  );

  const response = await fetch(resolveMediaSrc(data.upload_url), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!response.ok) throw new UploadTransferError(response.status);

  return data.public_url;
}

export type UploadFailureKind = "tooLarge" | "storageUnavailable" | "rejected" | "failed";

const STORAGE_UNAVAILABLE_STATUS = 503;
// 4xx answers from our API that a retry can plausibly clear (timeout, rate limit).
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

export function classifyUploadFailure(error: unknown): UploadFailureKind {
  if (error instanceof FileTooLargeError) return "tooLarge";
  if (isApiError(error) && error.errorCode === "storage_backend_unavailable") {
    return "storageUnavailable";
  }
  // A refused PUT is usually an expired or one-shot signature: a retry mints a
  // fresh upload URL, so transfer failures always stay retryable.
  if (!isApiError(error)) return "failed";
  if (error.status === STORAGE_UNAVAILABLE_STATUS) return "storageUnavailable";
  if (error.status >= 400 && error.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(error.status)) {
    return "rejected";
  }
  return "failed";
}

export function isRetryableUploadFailure(kind: UploadFailureKind): boolean {
  return kind === "storageUnavailable" || kind === "failed";
}
