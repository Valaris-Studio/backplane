// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, BookOpen, Check, Hash, Link2, MoreVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IntegrationsPanel } from "@/features/integrations/components/IntegrationsPanel";
import { NotificationPreferences } from "@/features/notifications";
import { DangerZoneSection } from "@/features/workspaces/components/DangerZoneSection";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";
import { copyTextToClipboard } from "@/lib/clipboard";

export function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const docsBasePath = useDocsBasePath();
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.find((w) => w.slug === slug);
  const [idCopied, setIdCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  function copyWorkspaceId() {
    if (!workspace) return;
    void copyTextToClipboard(workspace.id).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    });
  }

  function copyWorkspaceLink() {
    if (!slug) return;
    const url = `${window.location.origin}/${slug}`;
    void copyTextToClipboard(url).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.subtitle")}
        actions={
          workspace ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("workspaces.actions.more")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={copyWorkspaceId} closeOnClick={false}>
                  {idCopied ? (
                    <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                  ) : (
                    <Hash className="mr-2 h-4 w-4" />
                  )}
                  {idCopied ? t("workspaces.actions.idCopied") : t("workspaces.actions.copyId")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={copyWorkspaceLink} closeOnClick={false}>
                  {linkCopied ? (
                    <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  {linkCopied ? t("workspaces.actions.linkCopied") : t("workspaces.actions.copyLink")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />

      {slug ? <IntegrationsPanel slug={slug} /> : null}

      {slug ? <NotificationPreferences slug={slug} /> : null}

      {/* MCP install/config moved to docs; personal keys to the account menu */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-primary/10">
              <BookOpen className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>{t("settings.docsPointer.title")}</CardTitle>
              <CardDescription>
                {t("settings.docsPointer.description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link
            to={`${docsBasePath}/installing-the-mcp-server`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {t("settings.docsPointer.link")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </CardContent>
      </Card>

      {slug ? <DangerZoneSection slug={slug} /> : null}
    </div>
  );
}
