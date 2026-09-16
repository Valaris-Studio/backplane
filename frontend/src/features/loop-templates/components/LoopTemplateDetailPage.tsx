// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ComponentProps, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { useDuplicateLoopTemplate } from "../hooks/useLoopTemplateList";
import { ArchiveTemplateDialog } from "./ArchiveTemplateDialog";
import { useLoopTemplateDetail } from "../hooks/useLoopTemplateDetail";
import {
  TemplateDraftProvider,
  useTemplateDraftContext,
} from "../hooks/TemplateDraftProvider";
import { LoopTemplateNameField } from "./LoopTemplateNameField";
import { LoopTemplatePublishAction } from "./LoopTemplatePublishAction";
import { TemplateSaveStatus } from "./TemplateSaveStatus";
import { TemplateReadOnlyBanner } from "./TemplateReadOnlyBanner";
import { TemplateLeaveGuard } from "./TemplateLeaveGuard";
import { LoopTemplateProfileTab } from "./LoopTemplateProfileTab";
import { LoopTemplatePromptsTab } from "./LoopTemplatePromptsTab";
import { LoopTemplateSlotsTab } from "./LoopTemplateSlotsTab";
import { LoopTemplateRailsTab } from "./LoopTemplateRailsTab";
import { LoopTemplateContractTab } from "./LoopTemplateContractTab";
import { LoopTemplateVersionsTab } from "./LoopTemplateVersionsTab";
import { LoopTemplateSharingTab } from "./LoopTemplateSharingTab";

// The detail SHELL: identity header, gated actions, and route-driven sub-tabs.

export const LOOP_TEMPLATE_TABS = [
  "profile",
  "prompts",
  "slots",
  "rails",
  "contract",
  "versions",
  "sharing",
] as const;

export type LoopTemplateTab = (typeof LOOP_TEMPLATE_TABS)[number];

const DEFAULT_TAB: LoopTemplateTab = "profile";

function resolveTab(segment: string | undefined): LoopTemplateTab {
  // An unknown segment renders the profile rather than a 404: the tab list is
  // presentation, and a stale bookmark should still show the template.
  return LOOP_TEMPLATE_TABS.includes(segment as LoopTemplateTab)
    ? (segment as LoopTemplateTab)
    : DEFAULT_TAB;
}

/**
 * The header Publish button, bound to the shell's draft store.
 *
 * Its own component for the same reason as `TemplateLeaveGuard`: the shell
 * RENDERS the provider and therefore cannot read the store it is creating, and
 * the publish action must flush the debounced draft before the server freezes
 * it into a version.
 */
function PublishFromHeader(
  props: Omit<
    ComponentProps<typeof LoopTemplatePublishAction>,
    "onBeforePublish"
  >,
) {
  const { flush } = useTemplateDraftContext();
  return <LoopTemplatePublishAction {...props} onBeforePublish={flush} />;
}

export function LoopTemplateDetailPage() {
  const { slug = "", templateRef = "", tab } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useWorkspaceAdmin(slug);

  // The manager's own header: name, emoji and tagline are all draft-editable,
  // so it reads the draft half the editor below it writes — otherwise a rename
  // shows the old name in the header while the editor shows the new one.
  const { data: template, isLoading } = useLoopTemplateDetail(
    slug,
    templateRef,
    true,
  );
  const duplicate = useDuplicateLoopTemplate(slug);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const activeTab = resolveTab(tab);

  if (isLoading || !template) {
    return <Skeleton className="h-40 w-full" data-testid="loop-template-detail-loading" />;
  }

  // System templates are CODE-defined — there is no row to archive, so the
  // action is absent rather than present-and-failing.
  const canArchive = isAdmin && !template.is_system;
  // Publish is the only action that bumps a version, and a system template is
  // code-defined: same gate as Archive, for the same reason.
  const canPublish = isAdmin && !template.is_system;

  function handleDuplicate() {
    duplicate.mutate({ ref: templateRef }, {
      onSuccess: (created) =>
        navigate(`/${slug}/runner/loops/${created.id}`, { replace: true }),
    });
  }

  return (
    // One store for the whole open template, above BOTH the header indicator
    // and the tab bodies. The key is the template identity: navigating to a
    // different template must mount a fresh store rather than carry one
    // template's dirty draft into another.
    <TemplateDraftProvider
      key={`${slug}:${templateRef}`}
      slug={slug}
      templateRef={templateRef}
    >
      <TemplateLeaveGuard stayWithin={`/${slug}/runner/loops/${templateRef}`} />
      <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <header
        data-testid="loop-template-detail-header"
        className="flex flex-wrap items-center gap-3"
      >
        <span className="text-2xl" aria-hidden>
          {template.profile?.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <LoopTemplateNameField name={template.name} />
            <Badge variant="secondary">v{template.version}</Badge>
            {template.is_system && (
              <Badge variant="info">{t("loopTemplates.detail.system")}</Badge>
            )}
            {template.has_unpublished_changes && (
              <Pill data-testid="loop-template-draft-pill" tint="warning">
                {t("loopTemplates.detail.unpublished")}
              </Pill>
            )}
          </h1>
          {template.profile?.tagline && (
            <p className="truncate text-sm text-muted-foreground">
              {template.profile.tagline}
            </p>
          )}
        </div>

        <TemplateSaveStatus />
        <PublishFromHeader
          slug={slug}
          templateRef={templateRef}
          version={template.version}
          canPublish={canPublish}
          onNavigateToTab={(nextTab) =>
            navigate(`/${slug}/runner/loops/${templateRef}/${nextTab}`)
          }
        />
        {isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDuplicate}
            disabled={duplicate.isPending}
            data-testid="loop-template-detail-duplicate"
          >
            <Copy className="mr-1.5 h-4 w-4" />
            {t("loopTemplates.library.duplicate")}
          </Button>
        )}
        {canArchive && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmingArchive(true)}
            data-testid="loop-template-detail-archive"
          >
            <Archive className="mr-1.5 h-4 w-4" />
            {t("loopTemplates.library.archive")}
          </Button>
        )}
      </header>

      <ArchiveTemplateDialog
        slug={slug}
        target={
          confirmingArchive
            ? { ref: templateRef, name: template.name }
            : null
        }
        onClose={() => setConfirmingArchive(false)}
      />

      <TemplateReadOnlyBanner />

      {/* Sub-tabs are ROUTES (operator Direction), so every tab is
          deep-linkable and the back button walks them. */}
      <nav
        aria-label={t("loopTemplates.detail.tabsLabel")}
        className="flex flex-wrap gap-1 border-b border-border/70"
      >
        {LOOP_TEMPLATE_TABS.map((name) => (
          <Link
            key={name}
            to={`/${slug}/runner/loops/${templateRef}/${name}`}
            data-testid={`loop-template-tab-${name}`}
            aria-current={activeTab === name ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === name
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`loopTemplates.detail.tabs.${name}`)}
          </Link>
        ))}
      </nav>

      <div data-testid={`loop-template-tabpanel-${activeTab}`}>
        {activeTab === "profile" ? (
          <LoopTemplateProfileTab slug={slug} templateRef={templateRef} />
        ) : activeTab === "prompts" ? (
          <LoopTemplatePromptsTab slug={slug} templateRef={templateRef} />
        ) : activeTab === "slots" ? (
          <LoopTemplateSlotsTab slug={slug} templateRef={templateRef} />
        ) : activeTab === "rails" ? (
          <LoopTemplateRailsTab slug={slug} templateRef={templateRef} />
        ) : activeTab === "contract" ? (
          <LoopTemplateContractTab slug={slug} templateRef={templateRef} />
        ) : activeTab === "versions" ? (
          <LoopTemplateVersionsTab slug={slug} templateRef={templateRef} />
        ) : (
          <LoopTemplateSharingTab slug={slug} templateRef={templateRef} />
        )}
      </div>
      </div>
    </TemplateDraftProvider>
  );
}
