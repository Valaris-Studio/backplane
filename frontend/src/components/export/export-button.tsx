// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { fetchExportBlob } from "@/lib/api-export";
import { downloadBlobAs } from "@/lib/download";

export interface ExportButtonProps extends Omit<ButtonProps, "children" | "onClick"> {
  endpoint: string;
  defaultFilename: string;
  entityLabel: string;
}

export function ExportButton({
  endpoint,
  defaultFilename,
  entityLabel,
  variant = "outline",
  size = "sm",
  ...buttonProps
}: ExportButtonProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (pending) return;
    setPending(true);
    try {
      const { blob, filename } = await fetchExportBlob(endpoint, defaultFilename);
      downloadBlobAs(filename, blob);
      toast.success(t("export.success", { entity: entityLabel }));
    } catch {
      toast.error(t("export.failure"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={pending || buttonProps.disabled}
      {...buttonProps}
    >
      {pending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="mr-1.5 h-3.5 w-3.5" />
      )}
      {pending ? t("export.inProgress") : t("export.button")}
    </Button>
  );
}
