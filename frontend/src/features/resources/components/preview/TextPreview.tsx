// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

interface TextPreviewProps {
  content: string;
}

export function TextPreview({ content }: TextPreviewProps) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded bg-muted/50 p-4">
      <pre className="whitespace-pre-wrap font-mono text-sm text-foreground">
        {content}
      </pre>
    </div>
  );
}
