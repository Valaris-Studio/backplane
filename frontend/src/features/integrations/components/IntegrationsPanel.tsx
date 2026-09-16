// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Plug } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useGitConnections } from "../api/use-git-connections";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { ConnectionList } from "./ConnectionList";
import { ConnectGitHubButton } from "./ConnectGitHubButton";
import { AddTokenButton } from "./AddTokenButton";
import { AddTokenConnectionDialog } from "./AddTokenConnectionDialog";

interface IntegrationsPanelProps {
  slug: string;
}

// Whitelist of OAuth-failure reasons we know how to phrase. Anything outside
// the list falls back to the generic message so we never echo unexpected
// query-string content into the UI.
const KNOWN_OAUTH_ERRORS = new Set([
  "state_invalid",
  "state_expired",
  "github_denied",
]);

function resolveOAuthErrorKey(raw: string | null): string {
  if (!raw) return "integrations.oauthError.default";
  return KNOWN_OAUTH_ERRORS.has(raw)
    ? `integrations.oauthError.${raw}`
    : "integrations.oauthError.default";
}

export function IntegrationsPanel({ slug }: IntegrationsPanelProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const panelRef = useRef<HTMLDivElement>(null);

  const connectionsQuery = useGitConnections(slug);
  const { isAdmin } = useWorkspaceAdmin(slug);

  // Capture the OAuth error reason on first render then immediately strip the
  // param. Using state (not the live searchParams) so the dismiss button can
  // hide the alert without re-reading the URL.
  const [oauthError, setOauthError] = useState<string | null>(() =>
    searchParams.get("oauth_error"),
  );
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  useEffect(() => {
    if (!searchParams.get("oauth_error")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("oauth_error");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Scroll into view when the backend sent us back with #integrations.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#integrations" && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const connections = connectionsQuery.data ?? [];
  // The empty state owns the CTAs when there is nothing to list, so the header
  // pair would only duplicate them.
  const showHeaderCta = connections.length > 0;

  return (
    <Card id="integrations" ref={panelRef}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-primary/10">
            <Plug className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>{t("integrations.title")}</CardTitle>
            <CardDescription>{t("integrations.subtitle")}</CardDescription>
          </div>
        </div>
        {showHeaderCta ? (
          <div className="flex shrink-0 items-center gap-2">
            <AddTokenButton
              onClick={() => setTokenDialogOpen(true)}
              disabled={!isAdmin}
            />
            <ConnectGitHubButton slug={slug} disabled={!isAdmin} />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {oauthError ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="flex-1 space-y-1">
              <p className="font-semibold text-destructive">
                {t("integrations.oauthError.title")}
              </p>
              <p className="text-destructive/90">
                {t(resolveOAuthErrorKey(oauthError))}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOauthError(null)}
            >
              {t("common.close")}
            </Button>
          </div>
        ) : null}

        {connectionsQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 rounded-[var(--radius-md)]" />
            ))}
          </div>
        ) : connectionsQuery.isError ? (
          <p className="rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-4 py-6 text-center text-sm text-muted-foreground">
            {t("common.loadError")}
          </p>
        ) : (
          <ConnectionList
            slug={slug}
            connections={connections}
            isAdmin={isAdmin}
            onAddToken={() => setTokenDialogOpen(true)}
          />
        )}
      </CardContent>

      <AddTokenConnectionDialog
        slug={slug}
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
      />
    </Card>
  );
}
