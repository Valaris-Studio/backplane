// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { useUploadUrl, useCreateResource } from "../api/use-resources";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { ApiError } from "@/lib/api-error";

interface FileUploadButtonProps {
  slug: string;
  boardId?: string;
  parentId?: string | null;
  disabled?: boolean;
}

export function FileUploadButton({
  slug,
  boardId,
  parentId,
  disabled = false,
}: FileUploadButtonProps) {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorMessage =
    error === null
      ? null
      : resolveApiErrorMessage(error, t, i18n, {
          fallbackKey: "errors.upload_failed",
        });
  const uploadUrl = useUploadUrl(slug, boardId);
  const createResource = useCreateResource(slug, boardId);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);

    try {
      const { upload_url, gcs_path } = await uploadUrl.mutateAsync({
        filename: file.name,
        content_type: file.type || "application/octet-stream",
      });

      const response = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!response.ok) {
        throw new ApiError("Upload failed", response.status, undefined, {
          errorCode: response.status === 413 ? "upload_too_large" : "upload_failed",
        });
      }

      await createResource.mutateAsync({
        name: file.name,
        resource_type: "file",
        parent_id: parentId ?? undefined,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        gcs_path,
      });
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />
      <RichTooltip i18nKey="workspace.resources.upload" side="top">
        <Button
          size="sm"
          variant="surface"
          disabled={uploading || disabled}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1 h-4 w-4" />
          {uploading ? t("resources.uploading") : t("resources.uploadFile")}
        </Button>
      </RichTooltip>
      {errorMessage && (
        <p role="alert" className="text-xs text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}
