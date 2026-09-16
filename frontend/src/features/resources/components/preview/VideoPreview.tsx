// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

interface VideoPreviewProps {
  url: string;
  onError?: () => void;
  mimeType?: string | null;
}

export function VideoPreview({ url, mimeType, onError }: VideoPreviewProps) {
  return (
    <div className="flex items-center justify-center">
      <video
        onError={onError}
        controls
        preload="metadata"
        className="max-h-[70vh] w-full rounded bg-black"
      >
        <source onError={onError} src={url} type={mimeType ?? undefined} />
      </video>
    </div>
  );
}
