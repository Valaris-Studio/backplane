// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { TimelineSimulator } from "@/features/timeline/components/TimelineSimulator";

export function BoardTimelinePage() {
  const { slug = "", boardId = "" } = useParams();
  return <TimelineSimulator key={`${slug}:${boardId}`} slug={slug} boardId={boardId} />;
}
