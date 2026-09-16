// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "./api";

export interface ExportResult {
  blob: Blob;
  filename: string;
}

const FILENAME_STAR_RE = /filename\*=(?:UTF-8''|)([^;]+)/i;
const FILENAME_RE = /filename="([^"]+)"|filename=([^;]+)/i;

export function parseFilenameFromContentDisposition(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const star = FILENAME_STAR_RE.exec(header);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = FILENAME_RE.exec(header);
  if (plain) {
    return (plain[1] ?? plain[2] ?? "").trim() || null;
  }
  return null;
}

export async function fetchExportBlob(
  path: string,
  fallbackFilename: string,
): Promise<ExportResult> {
  const response = await api.get(path, { responseType: "blob" });
  const blob = response.data as Blob;
  const filename =
    parseFilenameFromContentDisposition(
      response.headers?.["content-disposition"] as string | undefined,
    ) ?? fallbackFilename;
  return { blob, filename };
}
