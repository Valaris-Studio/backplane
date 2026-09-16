// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { MemberList } from "@/features/members/components/MemberList";

export function WorkspaceMembersPage() {
  const { slug = "" } = useParams();
  return <MemberList slug={slug} />;
}
