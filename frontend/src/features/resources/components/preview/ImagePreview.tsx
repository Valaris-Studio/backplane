// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface ImagePreviewProps {
  url: string;
  onError?: () => void;
  alt: string;
}

export function ImagePreview({ url, alt, onError }: ImagePreviewProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="flex items-center justify-center">
      {!loaded && <Skeleton className="h-[50vh] w-full" />}
      <img
        onError={onError}
        src={url}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={`max-h-[70vh] object-contain rounded ${loaded ? "block" : "hidden"}`}
      />
    </div>
  );
}
