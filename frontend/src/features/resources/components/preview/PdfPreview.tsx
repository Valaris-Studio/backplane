// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";

interface PdfPreviewProps {
  url: string;
}

export function PdfPreview({ url }: PdfPreviewProps) {
  const { t } = useTranslation();

  return (
    <div className="w-full">
      <iframe
        src={url}
        title={t("resources.pdfPreview")}
        className="w-full h-[70vh] rounded border-0"
      />
      <noscript>
        <p className="text-sm text-muted-foreground mt-2">
          {t("resources.pdfFallback")}
        </p>
      </noscript>
    </div>
  );
}
