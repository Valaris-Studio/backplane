// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { TeamPanel } from "@/features/agents/components/TeamPanel";

// Runner Console → Teams tab. A team is the live binding of a runner credential
// to the ROLES it may take at assignment time (the scheduler reads
// AgentTeamMember.roles in _resolve_role); it is NOT pre-runner dead vocabulary.
// Reuses the existing slug-driven TeamPanel; the console reframes the copy.
export function RunnerTeamsTab({ slug: slugProp }: { slug?: string } = {}) {
  const params = useParams();
  const slug = slugProp ?? params.slug ?? "";
  return <TeamPanel slug={slug} />;
}
