// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { Resource } from "@/types/resource";

interface NoPreviewProps {
  resource: Resource;
  downloadUrl: string;
}

export function NoPreview({ resource, downloadUrl }: NoPreviewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-[var(--radius-cap)] bg-muted">
        <FileText className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{resource.name}</p>
        {resource.size_bytes != null && (
          <p className="text-xs text-muted-foreground">
            {formatBytes(resource.size_bytes)}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {t("resources.noPreviewDescription")}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={() => window.open(downloadUrl, "_blank")}
      >
        <Download className="h-4 w-4" />
        {t("common.download")}
      </Button>
    </div>
  );
}
