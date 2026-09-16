// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  File,
  FileText,
  FileSpreadsheet,
  FileArchive,
  FileCode,
  FileVideo,
  FileAudio,
  FileImage,
  type LucideIcon,
} from "lucide-react";

const EXACT_MIME: Record<string, LucideIcon> = {
  "application/pdf": FileText,
  "application/msword": FileText,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": FileText,
  "application/vnd.ms-excel": FileSpreadsheet,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": FileSpreadsheet,
  "application/vnd.ms-powerpoint": FileText,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": FileText,
  "application/zip": FileArchive,
  "application/x-rar-compressed": FileArchive,
  "application/gzip": FileArchive,
  "application/x-tar": FileArchive,
  "application/x-7z-compressed": FileArchive,
  "application/json": FileCode,
  "application/xml": FileCode,
  "application/javascript": FileCode,
  "text/html": FileCode,
  "text/css": FileCode,
  "text/csv": FileSpreadsheet,
};

const PREFIX_MIME: [string, LucideIcon][] = [
  ["image/", FileImage],
  ["video/", FileVideo],
  ["audio/", FileAudio],
  ["text/", FileText],
];

export function getFileIcon(mimeType: string): LucideIcon {
  if (EXACT_MIME[mimeType]) return EXACT_MIME[mimeType];
  for (const [prefix, icon] of PREFIX_MIME) {
    if (mimeType.startsWith(prefix)) return icon;
  }
  return File;
}
