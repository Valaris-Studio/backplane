// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";

interface SheetTableProps {
  rows: string[][];
}

// Cap rendered rows so a huge sheet doesn't lock the main thread building DOM.
const MAX_ROWS = 500;

// Shared by CsvPreview and SpreadsheetPreview: both arrive at the same
// row-of-cells shape from different parsers and must render identically.
export function SheetTable({ rows }: SheetTableProps) {
  const { t } = useTranslation();
  const [header, ...body] = rows;
  const truncated = body.length > MAX_ROWS;
  const visible = truncated ? body.slice(0, MAX_ROWS) : body;

  return (
    <div className="max-h-[70vh] overflow-auto rounded border border-border/50">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
          <tr>
            {header?.map((cell, i) => (
              <th
                key={i}
                className="border-b border-border/60 px-3 py-2 text-left font-semibold"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, ri) => (
            <tr key={ri} className="odd:bg-muted/20">
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className="border-b border-border/40 px-3 py-1.5 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("resources.csvTruncated", {
            shown: MAX_ROWS,
            total: body.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
