// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";

interface DocumentPreviewProps {
  data: ArrayBuffer;
}

type ConvertState =
  | { status: "converting" }
  | { status: "ready"; html: string }
  | { status: "failed" };

export function DocumentPreview({ data }: DocumentPreviewProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ConvertState>({ status: "converting" });

  useEffect(() => {
    let cancelled = false;

    // mammoth's package "browser" field remaps its node-only unzip/files
    // modules, so the default entry bundles cleanly; the dynamic import keeps
    // the converter out of the main bundle.
    import("mammoth")
      .then((m) => m.default.convertToHtml({ arrayBuffer: data }))
      .then((result) => {
        if (!cancelled) {
          setState({
            status: "ready",
            html: DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true } }),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [data]);

  if (state.status === "converting") {
    return <Skeleton className="h-[40vh] w-full" />;
  }

  if (state.status === "failed") {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t("resources.officeParseFailed")}
      </p>
    );
  }

  return (
    <div
      className="prose prose-sm dark:prose-invert max-h-[70vh] max-w-none overflow-auto rounded border border-border/50 px-4 py-3"
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  );
}
