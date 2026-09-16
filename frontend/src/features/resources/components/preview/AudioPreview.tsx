// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

interface AudioPreviewProps {
  url: string;
  onError?: () => void;
  mimeType?: string | null;
}

export function AudioPreview({ url, mimeType, onError }: AudioPreviewProps) {
  return (
    <div className="flex items-center justify-center p-6">
      <audio onError={onError} controls preload="metadata" className="w-full">
        <source onError={onError} src={url} type={mimeType ?? undefined} />
      </audio>
    </div>
  );
}
