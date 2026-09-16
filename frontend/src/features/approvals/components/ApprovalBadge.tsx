// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useApprovals } from "../hooks/useApprovals";

interface ApprovalBadgeProps {
  slug: string;
}

export function ApprovalBadge({ slug }: ApprovalBadgeProps) {
  const { data: approvals } = useApprovals(slug, "pending");
  const count = approvals?.length ?? 0;

  if (count === 0) return null;

  // Plain pill — no bevel/inset shadow, no uppercase tracking. Sized smaller
  // than the shared <Badge> so it sits unobtrusively next to the menu label.
  return (
    <span className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-warning/90 px-1.5 py-0 text-[0.65rem] font-semibold leading-[1.1rem] text-[oklch(0.22_0.04_68)] tabular-nums">
      {count}
    </span>
  );
}
