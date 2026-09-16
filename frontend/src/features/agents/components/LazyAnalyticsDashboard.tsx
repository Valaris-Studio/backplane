// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, lazy } from "react";
import { Skeleton } from "@/components/ui/skeleton";

// recharts is a large dep used ONLY by the analytics charts on the runner
// overview surfaces. Lazy-load so it splits out of the main bundle and arrives
// only when an overview tab renders. Named-export remap keeps the underlying
// AnalyticsDashboard importable directly by its tests.
const AnalyticsDashboard = lazy(() =>
  import("./AnalyticsDashboard").then((m) => ({ default: m.AnalyticsDashboard })),
);

interface LazyAnalyticsDashboardProps {
  slug: string;
}

export function LazyAnalyticsDashboard({ slug }: LazyAnalyticsDashboardProps) {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" aria-hidden />}>
      <AnalyticsDashboard slug={slug} />
    </Suspense>
  );
}
