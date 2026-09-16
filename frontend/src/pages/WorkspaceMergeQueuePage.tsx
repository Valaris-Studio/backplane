// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { MergeQueuePanel } from "@/features/merge-queue/components/MergeQueuePanel";

export function WorkspaceMergeQueuePage() {
  const { slug = "" } = useParams();
  return <MergeQueuePanel slug={slug} />;
}
