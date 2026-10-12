// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import { uploadWorkspaceMedia } from "@/lib/media-upload";

export function useImageUpload(workspaceSlug: string) {
  const [isUploading, setIsUploading] = useState(false);

  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      setIsUploading(true);
      try {
        return await uploadWorkspaceMedia(workspaceSlug, file, file.type);
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceSlug],
  );

  return { uploadImage, isUploading };
}
