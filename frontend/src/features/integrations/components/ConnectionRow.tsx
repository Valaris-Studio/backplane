// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Github,
  GitBranch,
  HelpCircle,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useDeleteGitConnection,
  useVerifyGitConnection,
} from "../api/use-git-connections";
import { formatScopeList } from "../utils/format-scope";
import { GitHubTokenGuidance } from "./GitHubTokenGuidance";
import type {
  GitConnection,
  GitConnectionCheck,
  GitProvider,
} from "@/types/git";

interface ConnectionRowProps {
  slug: string;
  connection: GitConnection;
  // Resolve the connecting user's display name. Returns null when membership
  // hasn't loaded yet — caller decides whether to show fallback (uuid suffix).
  resolveUserName?: (userId: string) => string | null;
  isAdmin: boolean;
}

const PROVIDER_ICONS: Record<GitProvider, typeof Github> = {
  github: Github,
  // Lucide doesn't ship gitlab/gitea/bitbucket marks; fall back to a neutral mark.
  gitlab: GitBranch,
  gitea: GitBranch,
  bitbucket: GitBranch,
  other: GitBranch,
};

type HealthState =
  | "healthy"
  | "scopesUnconfirmed"
  | "failing"
  | "unverified";

// Health is read straight off the row the server last wrote — no client timers,
// no inference. `last_error` outranks `last_verified_at` because a connection
// that verified once and failed since is broken NOW, and an operator reading
// "working" on a dead credential is worse than no chip at all.
const HEALTH_STYLES: Record<
  HealthState,
  { className: string; Icon: typeof CheckCircle2 }
> = {
  healthy: {
    className:
      "border-transparent bg-success/16 text-[color:var(--color-success-foreground)]",
    Icon: CheckCircle2,
  },
  scopesUnconfirmed: {
    className:
      "border-transparent bg-warning/18 text-[color:var(--color-warning-foreground)]",
    Icon: AlertTriangle,
  },
  failing: {
    className:
      "border-transparent bg-destructive/14 text-[color:var(--color-error-foreground)]",
    Icon: AlertTriangle,
  },
  unverified: {
    className: "border-border/70 bg-muted/40 text-muted-foreground",
    Icon: HelpCircle,
  },
};

function resolveHealth(connection: GitConnection): HealthState {
  if (connection.last_error) return "failing";
  // Explicitly false only: null means no probe ever assessed the scopes, and
  // warning on that would flag every row written before the verdict existed.
  if (connection.scopes_confirmed === false) return "scopesUnconfirmed";
  return connection.last_verified_at ? "healthy" : "unverified";
}

function formatConnectedAt(iso: string): string {
  return formatDate(iso);
}

function shortenUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

export function ConnectionRow({
  slug,
  connection,
  resolveUserName,
  isAdmin,
}: ConnectionRowProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState<GitConnectionCheck[] | null>(null);
  const deleteConnection = useDeleteGitConnection(slug);
  const verifyConnection = useVerifyGitConnection(slug);

  const ProviderIcon = PROVIDER_ICONS[connection.provider] ?? GitBranch;
  const connectedByName =
    resolveUserName?.(connection.connected_by) ??
    shortenUuid(connection.connected_by);
  const scopesLabel = formatScopeList(connection.scopes);
  const health = resolveHealth(connection);
  const { className: healthClassName, Icon: HealthIcon } = HEALTH_STYLES[health];

  async function handleConfirmDelete() {
    await deleteConnection.mutateAsync(connection.id);
    setConfirming(false);
  }

  async function handleVerify() {
    // An unhealthy verdict arrives as a 200 with failing checks; only a
    // transport failure rejects, and the refreshed row's last_error covers it.
    const result = await verifyConnection.mutateAsync(connection.id);
    setChecks(result.checks);
  }

  return (
    <div
      data-testid="integration-connection-row"
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-4 py-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary/10 text-primary">
            <ProviderIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">
                {connection.account_login}
              </p>
              <Badge variant="outline">
                {t(`integrations.accountType.${connection.account_type}`)}
              </Badge>
              <Badge variant="outline">
                {t(`integrations.authKind.${connection.auth_kind}`)}
              </Badge>
              <span
                data-testid="connection-health-chip"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.67rem] font-semibold uppercase tracking-[0.16em]",
                  healthClassName,
                )}
              >
                <HealthIcon className="h-3 w-3" />
                {t(`integrations.health.${health}`)}
              </span>
            </div>
            {connection.base_url ? (
              <p className="truncate text-xs text-muted-foreground">
                {connection.base_url}
              </p>
            ) : null}
            {scopesLabel ? (
              <p className="text-xs text-muted-foreground">{scopesLabel}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("integrations.connectedBy", {
                name: connectedByName,
                date: formatConnectedAt(connection.created_at),
              })}
            </p>
            {connection.last_error ? (
              <p className="text-xs text-destructive">{connection.last_error}</p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && confirming ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmDelete}
                disabled={deleteConnection.isPending}
              >
                {t("integrations.deleteConnection")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleteConnection.isPending}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <>
              {/* Visible-but-disabled for members (matching the panel CTAs);
                  delete stays admin-only hidden — a control you can never
                  use for a destructive act is noise, not information. */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerify}
                disabled={!isAdmin || verifyConnection.isPending}
              >
                {verifyConnection.isPending
                  ? t("integrations.verifying")
                  : t("integrations.verify")}
              </Button>
              {isAdmin ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirming(true)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t("integrations.deleteConnection")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {connection.provider === "github" &&
      connection.auth_kind === "pat" &&
      connection.scopes_confirmed === false ? (
        <GitHubTokenGuidance />
      ) : null}

      {checks ? (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-border/60 bg-background/60 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("integrations.checksTitle")}
          </p>
          <ul className="space-y-2">
            {checks.map((check) => (
              <li
                key={check.name}
                data-testid="connection-check"
                data-ok={check.ok}
                className="flex items-start gap-2 text-xs"
              >
                {check.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-success-foreground)]" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-foreground">
                    {/* Backend check names use ":" (scope:repo), which is
                        i18next's NAMESPACE separator — keys hold "_" and the
                        name is normalized here, or lookup silently falls
                        through to the raw key. */}
                    {t(
                      `integrations.checkName.${check.name.replace(/:/g, "_")}`,
                      { defaultValue: check.name },
                    )}
                  </p>
                  <p className="text-muted-foreground">{check.guidance}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
