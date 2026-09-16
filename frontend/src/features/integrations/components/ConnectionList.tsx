// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ConnectionRow } from "./ConnectionRow";
import { ConnectGitHubButton } from "./ConnectGitHubButton";
import { AddTokenButton } from "./AddTokenButton";
import { useMembers } from "@/features/members/api/use-members";
import type { GitConnection } from "@/types/git";

interface ConnectionListProps {
  slug: string;
  connections: GitConnection[];
  isAdmin: boolean;
  onAddToken: () => void;
}

export function ConnectionList({
  slug,
  connections,
  isAdmin,
  onAddToken,
}: ConnectionListProps) {
  const { t } = useTranslation();
  const membersQuery = useMembers(slug);

  function resolveUserName(userId: string): string | null {
    const match = membersQuery.data?.find((m) => m.user_id === userId);
    return match?.name ?? match?.email ?? null;
  }

  // The empty state has to teach, not just report emptiness: an owner who has
  // never issued a PAT needs to know WHY Backplane wants a credential before
  // being asked for one.
  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-border/60 bg-[color:var(--color-surface-1)] px-6 py-8 text-center">
        <p className="text-sm font-semibold text-foreground">
          {t("integrations.connectionsEmptyTitle")}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("integrations.connectionsEmptyBody")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("integrations.connectionsEmptyHint")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <ConnectGitHubButton slug={slug} disabled={!isAdmin} />
          <AddTokenButton onClick={onAddToken} disabled={!isAdmin} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          slug={slug}
          connection={connection}
          resolveUserName={resolveUserName}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}
