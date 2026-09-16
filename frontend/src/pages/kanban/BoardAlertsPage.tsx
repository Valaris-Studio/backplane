// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { AlertThresholdList } from "@/features/alerts/components/AlertThresholdList";
import { useBoard } from "@/features/kanban/api/use-boards";

export function BoardAlertsPage() {
  const { slug = "", boardId: routeBoardId = "" } = useParams();
  // The :boardId route param also accepts the board's slug, but
  // GET /alerts/thresholds?board_id=... is a UUID-only query param — thread
  // the fetched board's canonical id (BoardLayout already holds this query,
  // so it's usually a cache hit). On a COLD direct navigation the cache can
  // be empty for a render tick; falling back to the raw route param there
  // would fire exactly one sluggy (422-triggering) request, so boardPending
  // holds the fetch instead until the board resolves.
  const { data: board } = useBoard(slug, routeBoardId);

  return (
    <AlertThresholdList slug={slug} boardId={board?.id} boardPending={!board} />
  );
}
