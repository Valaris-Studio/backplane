// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { AgentDetail } from "@/features/agents/components/AgentDetail";

export function AgentDetailPage() {
  const { slug = "", agentId = "" } = useParams();
  return <AgentDetail slug={slug} agentId={agentId} />;
}
