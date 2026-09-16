// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { BoardStats } from "@/types/dashboard";
import { BUCKETS } from "../utils/board-buckets";
import { BoardActivityPill } from "./BoardActivityPill";

interface BoardStatsPanelProps {
  slug: string;
  boardStats: BoardStats[] | undefined;
  isLoading?: boolean;
}

export function BoardStatsPanel({
  slug,
  boardStats,
  isLoading = false,
}: BoardStatsPanelProps) {
  const { t } = useTranslation();

  return (
    <Card className="self-start overflow-hidden">
      <CardContent className="p-[var(--card-padding)]">
        <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("dashboard.boardStats.title")}
        </p>

        {isLoading ? (
          <div
            data-testid="board-stats-skeleton"
            className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2"
          >
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        ) : !boardStats?.length ? (
          <p
            data-testid="board-stats-empty"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            {t("dashboard.boardStats.empty")}
          </p>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {boardStats.map((board) => (
                <li key={board.board_id} data-testid="board-stat-row">
                  <BoardActivityPill slug={slug} board={board} />
                </li>
              ))}
            </ul>
            <DistributionLegend boardStats={boardStats} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Reads the same BUCKETS the bars read, so a swatch can never drift from the
// segment it explains. Only buckets some board actually paints get an entry —
// advertising a color the bar never shows is worse than no legend.
function DistributionLegend({ boardStats }: { boardStats: BoardStats[] }) {
  const { t } = useTranslation();
  const present = BUCKETS.filter(({ key }) =>
    boardStats.some((board) => board.distribution[key] > 0),
  );

  if (!present.length) return null;

  return (
    <div
      data-testid="board-stats-legend"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-muted-foreground/70"
    >
      <span>{t("dashboard.boardStats.legendLabel")}</span>
      {present.map(({ key, label, accent }) => (
        <span
          key={key}
          data-testid="board-stats-legend-entry"
          className="flex items-center gap-1"
        >
          <span
            aria-hidden
            data-testid="board-stats-legend-swatch"
            className="size-1.5 rounded-full"
            style={{ backgroundColor: accent }}
          />
          {t(label)}
        </span>
      ))}
    </div>
  );
}
