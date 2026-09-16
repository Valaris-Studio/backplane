// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { ApprovalList } from "@/features/approvals/components/ApprovalList";

export function WorkspaceApprovalsPage() {
  const { slug = "" } = useParams();
  return <ApprovalList slug={slug} />;
}
