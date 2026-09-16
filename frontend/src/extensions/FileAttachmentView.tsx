// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Loader2, Download, X } from "lucide-react";
import { getFileIcon } from "@/lib/file-icons";
import { formatBytes } from "@/lib/format";

export function FileAttachmentView({ node, deleteNode, editor }: NodeViewProps) {
  const { t } = useTranslation();
  const { src, filename, fileSize, mimeType, uploading } = node.attrs;
  const FileIcon = getFileIcon(mimeType);
  const editable = editor.isEditable;

  if (uploading) {
    return (
      <NodeViewWrapper data-file-attachment="">
        <div className="group inline-flex max-w-sm items-center gap-2 rounded-md border border-border/70 bg-card px-3 py-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="truncate text-sm text-muted-foreground">
            {t("editor.uploading")}
          </span>
        </div>
      </NodeViewWrapper>
    );
  }

  function handleClick() {
    if (src) window.open(src, "_blank", "noopener");
  }

  return (
    <NodeViewWrapper data-file-attachment="">
      <div className="group relative inline-flex max-w-sm items-center gap-2 rounded-md border border-border/70 bg-secondary px-3 py-2 transition-colors hover:bg-accent">
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className="truncate text-sm font-medium">{filename}</span>
          {fileSize > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatBytes(fileSize)}
            </span>
          )}
        </button>
        <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        {editable && (
          <button
            type="button"
            onClick={deleteNode}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
            title={t("common.delete")}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}
