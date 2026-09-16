// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { parseCsv } from "../../utils/parse-csv";
import { SheetTable } from "./SheetTable";
import { TextPreview } from "./TextPreview";

interface CsvPreviewProps {
  content: string;
}

export function CsvPreview({ content }: CsvPreviewProps) {
  const rows = useMemo(() => parseCsv(content), [content]);

  // Degrade to raw text if it doesn't look tabular (single column everywhere).
  const looksTabular = rows.length > 0 && rows.some((r) => r.length > 1);
  if (!looksTabular) return <TextPreview content={content} />;

  return <SheetTable rows={rows} />;
}
