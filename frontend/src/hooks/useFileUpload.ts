// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import { api } from "@/lib/api";

interface UploadResponse {
  upload_url: string;
  public_url: string;
}

export interface FileUploadResult {
  url: string;
  filename: string;
  fileSize: number;
  mimeType: string;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export function useFileUpload(workspaceSlug: string) {
  const [isUploading, setIsUploading] = useState(false);

  const uploadFile = useCallback(
    async (file: File): Promise<FileUploadResult> => {
      if (file.size > MAX_FILE_SIZE) {
        throw new Error("FILE_TOO_LARGE");
      }

      setIsUploading(true);
      try {
        const { data } = await api.post<UploadResponse>(
          `/workspaces/${workspaceSlug}/media/upload-url`,
          { filename: file.name, content_type: file.type || "application/octet-stream" },
        );

        const uploadUrl = data.upload_url.startsWith("/")
          ? `${api.defaults.baseURL?.replace("/api", "")}${data.upload_url}`
          : data.upload_url;

        await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });

        const publicUrl = data.public_url.startsWith("/")
          ? `${window.location.origin}${data.public_url}`
          : data.public_url;

        return {
          url: publicUrl,
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        };
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceSlug],
  );

  return { uploadFile, isUploading };
}
