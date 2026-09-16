// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { SheetTable } from "./SheetTable";

interface SpreadsheetPreviewProps {
  data: ArrayBuffer;
}

type ParseState =
  | { status: "parsing" }
  | { status: "ready"; rows: string[][] }
  | { status: "failed" };

export function SpreadsheetPreview({ data }: SpreadsheetPreviewProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ParseState>({ status: "parsing" });

  useEffect(() => {
    let cancelled = false;

    // SheetJS is ~400KB; importing it here keeps it out of every other chunk
    // and defers the cost to the first spreadsheet a user actually opens.
    import("xlsx")
      .then(({ read, utils }) => {
        const workbook = read(data, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const sheet = firstSheetName
          ? workbook.Sheets[firstSheetName]
          : undefined;
        const rows: string[][] = sheet
          ? utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false })
          : [];
        if (!cancelled) setState({ status: "ready", rows });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [data]);

  if (state.status === "parsing") return <Skeleton className="h-[40vh] w-full" />;

  if (state.status === "failed") {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t("resources.officeParseFailed")}
      </p>
    );
  }

  if (state.rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t("resources.spreadsheetEmpty")}
      </p>
    );
  }

  return <SheetTable rows={state.rows} />;
}
