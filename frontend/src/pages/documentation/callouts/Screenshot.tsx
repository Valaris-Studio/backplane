// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDocumentationCopy } from "../use-documentation-copy";

type AspectRatio = "16:9" | "4:3" | "square";

interface ScreenshotProps {
  description: string | string[];
  alt: string;
  aspectRatio?: AspectRatio;
  caption: string;
  className?: string;
}

// The ratio is a FLOOR, not a cap. Translated bullet lists routinely wrap past
// a 16:9 box at 390px, and a hard `aspect-*` + `overflow-hidden` clipped them.
// clamp() keeps the empty-ish desktop case looking like the intended ratio
// while letting the frame grow to whatever the localized copy actually needs.
const minHeightClassByRatio: Record<AspectRatio, string> = {
  "16:9": "min-h-[clamp(11rem,42vw,24rem)]",
  "4:3": "min-h-[clamp(13rem,56vw,26rem)]",
  square: "min-h-[clamp(15rem,74vw,28rem)]",
};

export function Screenshot({
  description,
  alt,
  aspectRatio = "16:9",
  caption,
  className,
}: ScreenshotProps) {
  const { copy } = useDocumentationCopy();
  const descriptionItems = Array.isArray(description)
    ? description
    : null;

  return (
    <figure
      data-screenshot
      data-alt={alt}
      data-stagger-item
      className={cn("my-6 space-y-2", className)}
    >
      <div
        data-screenshot-frame
        className={cn(
          "relative flex w-full items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed border-border bg-[color:var(--color-surface-2)]/60 px-4 pb-6 pt-12 sm:px-6",
          minHeightClassByRatio[aspectRatio],
        )}
      >
        <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-[color:var(--color-surface-1)] px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          <ImageIcon className="h-3 w-3" aria-hidden />
          {copy.shell.screenshotPlaceholder}
        </span>
        <div className="max-w-prose text-sm leading-6 text-muted-foreground">
          {descriptionItems ? (
            <ul className="list-disc space-y-1 pl-5">
              {descriptionItems.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>{description as string}</p>
          )}
        </div>
      </div>
      <figcaption className="text-xs leading-5 text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}
