// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { resourceKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { categorizeFile, getLanguage } from "../../utils/file-categories";
import { ImagePreview } from "./ImagePreview";
import { VideoPreview } from "./VideoPreview";
import { AudioPreview } from "./AudioPreview";
import { PdfPreview } from "./PdfPreview";
import { TextPreview } from "./TextPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { CsvPreview } from "./CsvPreview";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import { DocumentPreview } from "./DocumentPreview";
import { NoPreview } from "./NoPreview";
import { Skeleton } from "@/components/ui/skeleton";
import type { Resource } from "@/types/resource";

// highlight.js (core + 10 language grammars + a CSS theme) is only needed when
// previewing a code file. Lazy-load so it splits out of the main bundle and
// loads on first code-file preview rather than on every route.
const CodePreview = lazy(() =>
  import("./CodePreview").then((m) => ({ default: m.CodePreview })),
);

interface FilePreviewProps {
  resource: Resource;
  downloadUrl: string;
  onRefreshUrl?: () => Promise<string | undefined>;
}

const TEXT_CATEGORIES = new Set(["markdown", "code", "text", "csv"]);

// Office formats are zip containers — they must be read as bytes, never
// decoded as text, so they get their own fetch rather than joining
// TEXT_CATEGORIES.
const BINARY_CATEGORIES = new Set(["spreadsheet", "document"]);

export function FilePreview({ resource, downloadUrl, onRefreshUrl }: FilePreviewProps) {
  const [refreshingUrl, setRefreshingUrl] = useState(false);
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const { t } = useTranslation();
  const category = categorizeFile(resource.name);
  const needsTextContent = TEXT_CATEGORIES.has(category);
  const needsBinaryContent = BINARY_CATEGORIES.has(category);

  const { data: textContent, isLoading, isError: textError, isFetching: fetchingText, refetch: retryText } = useQuery({
    queryKey: resourceKeys.previewText(resource.id, downloadUrl),
    queryFn: async () => {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error("Preview request failed");
      return response.text();
    },
    retry: false,
    enabled: needsTextContent,
    staleTime: 5 * 60 * 1000,
  });

  const { data: binaryContent, isLoading: isLoadingBinary, isError: binaryError, isFetching: fetchingBinary, refetch: retryBinary } = useQuery({
    queryKey: resourceKeys.previewBinary(resource.id, downloadUrl),
    queryFn: async () => {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error("Preview request failed");
      return response.arrayBuffer();
    },
    retry: false,
    enabled: needsBinaryContent,
    staleTime: 5 * 60 * 1000,
  });

  const retry = async () => {
    setRefreshingUrl(true);
    try {
      if (onRefreshUrl) {
        const refreshedUrl = await onRefreshUrl();
        // A changed URL starts its own query; the same URL still needs fresh bytes.
        if (!refreshedUrl || refreshedUrl !== downloadUrl) return;
      }
      if (needsTextContent || needsBinaryContent) {
        await (needsTextContent ? retryText() : retryBinary());
      } else {
        setFailedMediaUrl(null);
        setMediaAttempt((attempt) => attempt + 1);
      }
    } finally {
      setRefreshingUrl(false);
    }
  };

  if (failedMediaUrl === downloadUrl || (needsTextContent && textError) || (needsBinaryContent && binaryError)) {
    return <div role="alert" className="space-y-3 p-4 text-sm">
      <p>{t("resources.previewFailed", { name: resource.name })}</p>
      <Button variant="outline" size="sm" disabled={refreshingUrl || fetchingText || fetchingBinary} onClick={() => void retry()}>
        {t("resources.retry")}
      </Button>
    </div>;
  }

  if (category === "image") {
    return <ImagePreview key={`${downloadUrl}:${mediaAttempt}`} url={downloadUrl} alt={resource.name} onError={() => setFailedMediaUrl(downloadUrl)} />;
  }

  if (category === "video") {
    return <VideoPreview key={`${downloadUrl}:${mediaAttempt}`} url={downloadUrl} mimeType={resource.mime_type} onError={() => setFailedMediaUrl(downloadUrl)} />;
  }

  if (category === "audio") {
    return <AudioPreview key={`${downloadUrl}:${mediaAttempt}`} url={downloadUrl} mimeType={resource.mime_type} onError={() => setFailedMediaUrl(downloadUrl)} />;
  }

  if (category === "pdf") {
    return <PdfPreview url={downloadUrl} />;
  }

  if (needsBinaryContent) {
    if (isLoadingBinary || binaryContent === undefined) {
      return <Skeleton className="h-[40vh] w-full" />;
    }

    return category === "spreadsheet" ? (
      <SpreadsheetPreview data={binaryContent} />
    ) : (
      <DocumentPreview data={binaryContent} />
    );
  }

  if (needsTextContent) {
    if (isLoading || textContent === undefined) {
      return <Skeleton className="h-[40vh] w-full" />;
    }

    if (category === "markdown") {
      return <MarkdownPreview content={textContent} />;
    }

    if (category === "code") {
      return (
        <Suspense fallback={<Skeleton className="h-[40vh] w-full" />}>
          <CodePreview content={textContent} language={getLanguage(resource.name)} />
        </Suspense>
      );
    }

    if (category === "csv") {
      return <CsvPreview content={textContent} />;
    }

    return <TextPreview content={textContent} />;
  }

  return <NoPreview resource={resource} downloadUrl={downloadUrl} />;
}
