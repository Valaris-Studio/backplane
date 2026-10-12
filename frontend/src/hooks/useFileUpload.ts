// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import {
  FileTooLargeError,
  MAX_ATTACHMENT_BYTES,
  uploadWorkspaceMedia,
} from "@/lib/media-upload";

export interface FileUploadResult {
  url: string;
  filename: string;
  fileSize: number;
  mimeType: string;
}

const FALLBACK_MIME_TYPE = "application/octet-stream";

export function useFileUpload(workspaceSlug: string) {
  const [isUploading, setIsUploading] = useState(false);

  const uploadFile = useCallback(
    async (file: File): Promise<FileUploadResult> => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new FileTooLargeError();
      }

      const mimeType = file.type || FALLBACK_MIME_TYPE;
      setIsUploading(true);
      try {
        const url = await uploadWorkspaceMedia(workspaceSlug, file, mimeType);
        return { url, filename: file.name, fileSize: file.size, mimeType };
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceSlug],
  );

  return { uploadFile, isUploading };
}
