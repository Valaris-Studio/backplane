// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] bg-[color:color-mix(in_oklab,var(--color-surface-2)_82%,transparent)] before:absolute before:inset-0 before:-translate-x-full before:bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,white_52%,transparent),transparent)] before:animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
