// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import { api } from "@/lib/api";

interface UploadResponse {
  upload_url: string;
  public_url: string;
}

export function useImageUpload(workspaceSlug: string) {
  const [isUploading, setIsUploading] = useState(false);

  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      setIsUploading(true);
      try {
        const { data } = await api.post<UploadResponse>(
          `/workspaces/${workspaceSlug}/media/upload-url`,
          { filename: file.name, content_type: file.type },
        );

        // Upload file directly to signed URL (or local storage endpoint)
        const uploadUrl = data.upload_url.startsWith("/")
          ? `${api.defaults.baseURL?.replace("/api", "")}${data.upload_url}`
          : data.upload_url;

        await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });

        // Return the public URL for embedding in the editor
        if (data.public_url.startsWith("/")) {
          return `${window.location.origin}${data.public_url}`;
        }
        return data.public_url;
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceSlug],
  );

  return { uploadImage, isUploading };
}
