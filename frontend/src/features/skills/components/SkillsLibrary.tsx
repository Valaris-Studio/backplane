// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownPreview } from "@/features/resources/components/preview/MarkdownPreview";
import {
  useApprovals,
  useDecideApproval,
} from "@/features/approvals/hooks/useApprovals";
import { cn } from "@/lib/utils";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { skillKeys } from "@/lib/query-keys";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { hasToolsets, type SkillVersionStatus } from "@/types/skill";
import {
  useActivateCatalogSkill,
  useArchiveSkill,
  usePublishSkillVersion,
  useSkill,
  useSkillCatalog,
  useSkills,
  useSkillVersion,
  useUnarchiveSkill,
} from "../api/use-skills";
import { SkillEditorDialog } from "./SkillEditorDialog";

type LibraryTab = "workspace" | "catalog";

export function SkillsLibrary() {
  const { slug = "" } = useParams();
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<LibraryTab>("workspace");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [newVersionOpen, setNewVersionOpen] = useState(false);

  const skillsQuery = useSkills(slug, { includeArchived: showArchived });
  const catalogQuery = useSkillCatalog(slug);
  const activateSkill = useActivateCatalogSkill(slug);
  // Authoring (New skill / New version / Publish) is admin-only; members keep
  // the read-only library. Gating the controls means a member never even
  // sends the request.
  const { isAdmin } = useWorkspaceAdmin(slug);
  const publishVersion = usePublishSkillVersion(slug);
  const archiveSkill = useArchiveSkill(slug);
  const unarchiveSkill = useUnarchiveSkill(slug);

  const skills = useMemo(
    () => skillsQuery.data?.skills ?? [],
    [skillsQuery.data],
  );
  // Selection resolves against the UNFILTERED list so the detail pane survives
  // a search that filters the selected skill out of view.
  const selectedSkill = skills.find((s) => s.slug === selectedSlug) ?? null;

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query),
    );
  }, [skills, search]);

  // A catalog entry is activated when a workspace skill copied its slug or
  // carries its "catalog:{id}@{version}" origin — the "@" delimiter keeps
  // "catalog:foo-extended@1" from marking entry "foo".
  function isEntryActivated(catalogId: string) {
    return skills.some(
      (skill) =>
        skill.slug === catalogId ||
        skill.origin?.startsWith("catalog:" + catalogId + "@"),
    );
  }

  const detailQuery = useSkill(slug, selectedSkill?.slug ?? null);
  const versionQuery = useSkillVersion(
    slug,
    selectedSkill?.slug ?? null,
    selectedSkill?.latest_published_version ?? null,
  );

  // A new draft starts from the LATEST version by number — including an
  // unpublished draft — not from the latest published one the preview shows.
  const latestVersionNumber = detailQuery.data?.versions.length
    ? Math.max(...detailQuery.data.versions.map((v) => v.version))
    : null;
  const draftSourceQuery = useSkillVersion(
    slug,
    newVersionOpen ? (selectedSkill?.slug ?? null) : null,
    newVersionOpen ? latestVersionNumber : null,
  );

  // Absent key ⇒ no warnings: the field is a backend lint, not a contract
  // every payload carries.
  const lintWarnings = detailQuery.data?.lint_warnings ?? [];

  // SKILL.md is the open-standard entry point; its content is shown verbatim.
  const skillMarkdown =
    versionQuery.data?.files.find((f) => f.path === "SKILL.md")?.content ??
    versionQuery.data?.files[0]?.content;

  const approvalsQuery = useApprovals(slug);
  const decideApproval = useDecideApproval(slug);
  const queryClient = useQueryClient();

  // A proposed version is only actionable through its gating approval — match
  // on category + payload slug so an unrelated pending skill_publication in
  // the workspace cannot light up this skill's pane.
  const pendingProposal = useMemo(() => {
    if (!selectedSkill) return null;
    const hasProposedVersion = detailQuery.data?.versions.some(
      (version) => version.status === "proposed",
    );
    if (!hasProposedVersion) return null;
    return (
      approvalsQuery.data?.find(
        (approval) =>
          approval.category === "skill_publication" &&
          approval.status === "pending" &&
          approval.action_payload.slug === selectedSkill.slug,
      ) ?? null
    );
  }, [selectedSkill, detailQuery.data, approvalsQuery.data]);

  function decideProposal(decision: "approved" | "rejected") {
    if (!pendingProposal || decideApproval.isPending) return;
    const decidedSkillSlug = selectedSkill?.slug;
    decideApproval.mutate(
      {
        approvalId: pendingProposal.id,
        decision,
        // Stored on the approval, never rendered from the catalog — a plain
        // English trace of which surface decided it, not a translated string.
        reason: "decided from skills library",
      },
      {
        // Deciding publishes or rejects the version, so the skills queries
        // this screen renders from go stale. The shared approvals hook knows
        // nothing about skills — the invalidation belongs at the callsite.
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
          if (decidedSkillSlug) {
            queryClient.invalidateQueries({
              queryKey: skillKeys.detail(slug, decidedSkillSlug),
            });
          }
        },
      },
    );
  }

  function statusLabel(status: SkillVersionStatus) {
    return t(`skills.status.${status}`, { defaultValue: status });
  }

  const showEmptyLibrary =
    tab === "workspace" && !skillsQuery.isLoading && skills.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("skills.title")}
        description={t("skills.subtitle")}
        actions={
          isAdmin ? (
            <Button type="button" onClick={() => setCreateSkillOpen(true)}>
              {t("skills.authoring.newSkill")}
            </Button>
          ) : undefined
        }
      />

      {showEmptyLibrary ? (
        <EmptyState
          icon={GraduationCap}
          title={t("skills.empty.title")}
          description={t("skills.empty.description")}
          action={
            <Button type="button" onClick={() => setTab("catalog")}>
              {t("skills.tabs.fromCatalog")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant={tab === "workspace" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setTab("workspace")}
                >
                  {t("skills.tabs.workspace")}
                </Button>
                <Button
                  type="button"
                  variant={tab === "catalog" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setTab("catalog")}
                >
                  {t("skills.tabs.fromCatalog")}
                </Button>
              </div>

              {tab === "workspace" ? (
                <>
                  <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("skills.searchPlaceholder")}
                  />
                  {/* Member-visible on purpose: the list GET is member-
                      accessible; only archive-state CHANGES are admin-gated. */}
                  <Checkbox
                    checked={showArchived}
                    onCheckedChange={setShowArchived}
                    label={t("skills.archive.showArchived")}
                  />
                  {skillsQuery.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-14 w-full" />
                      <Skeleton className="h-14 w-full" />
                    </div>
                  ) : filteredSkills.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">
                      {t("skills.noMatches")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {filteredSkills.map((skill) => (
                        <li key={skill.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedSlug(skill.slug)}
                            className={cn(
                              "w-full rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors",
                              skill.slug === selectedSlug
                                ? "border-primary/40 bg-primary/5"
                                : "border-transparent hover:bg-muted/60",
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {skill.name}
                              </span>
                              {skill.archived_at && (
                                <Badge variant="outline">
                                  {t("skills.archive.archivedBadge")}
                                </Badge>
                              )}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {skill.description}
                            </span>
                            {hasToolsets(skill) && (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {skill.toolsets.map((toolsetId) => (
                                  <Badge
                                    key={toolsetId}
                                    variant="secondary"
                                    data-testid="skill-toolset-chip"
                                  >
                                    {toolsetId}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : catalogQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : (catalogQuery.data?.entries.length ?? 0) === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  {t("skills.catalog.empty")}
                </p>
              ) : (
                <ul className="space-y-1">
                  {catalogQuery.data?.entries.map((entry) => {
                    const activated = isEntryActivated(entry.catalog_id);
                    return (
                      <li
                        key={entry.catalog_id}
                        className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">
                            {entry.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {entry.description}
                          </span>
                          {hasToolsets(entry) && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {(entry.toolsets ?? []).map((toolsetId) => (
                                <Badge
                                  key={toolsetId}
                                  variant="secondary"
                                  data-testid="skill-toolset-chip"
                                >
                                  {toolsetId}
                                </Badge>
                              ))}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {activated && (
                            <Badge variant="secondary">
                              {t("skills.catalog.activated")}
                            </Badge>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={activated || activateSkill.isPending}
                            onClick={() =>
                              activateSkill.mutate(entry.catalog_id)
                            }
                          >
                            {t("skills.catalog.activate")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 p-4">
              {!selectedSkill ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("skills.detail.selectPrompt")}
                </p>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold text-foreground">
                          {selectedSkill.name}
                        </h2>
                        {selectedSkill.origin?.startsWith("catalog:") && (
                          <Badge variant="secondary">
                            {t("skills.detail.provenanceCatalog")}
                          </Badge>
                        )}
                        {selectedSkill.archived_at && (
                          <Badge variant="outline">
                            {t("skills.archive.archivedBadge")}
                          </Badge>
                        )}
                        {hasToolsets(selectedSkill) &&
                          selectedSkill.toolsets.map((toolsetId) => (
                            <Badge
                              key={toolsetId}
                              variant="secondary"
                              data-testid="skill-toolset-chip"
                            >
                              {toolsetId}
                            </Badge>
                          ))}
                      </div>
                      {isAdmin && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            archiveSkill.isPending || unarchiveSkill.isPending
                          }
                          onClick={() =>
                            selectedSkill.archived_at
                              ? unarchiveSkill.mutate(selectedSkill.slug)
                              : archiveSkill.mutate(selectedSkill.slug)
                          }
                        >
                          {selectedSkill.archived_at
                            ? t("skills.archive.unarchive")
                            : t("skills.archive.archive")}
                        </Button>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {selectedSkill.description}
                    </p>
                  </div>

                  {lintWarnings.length > 0 && (
                    <p
                      role="status"
                      data-testid="skill-lint-warnings"
                      className="rounded-[var(--radius-md)] border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      {t("skills.detail.lintWarnings", {
                        tools: lintWarnings.join(", "),
                      })}
                    </p>
                  )}

                  {pendingProposal && (
                    <div
                      role="status"
                      className="space-y-2 rounded-[var(--radius-md)] border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      <p>
                        {t("skills.proposal.pendingBanner", {
                          version: pendingProposal.action_payload.version,
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={decideApproval.isPending}
                          onClick={() => decideProposal("approved")}
                        >
                          {t("skills.proposal.approve")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={decideApproval.isPending}
                          onClick={() => decideProposal("rejected")}
                        >
                          {t("skills.proposal.reject")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {versionQuery.isLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : skillMarkdown !== undefined ? (
                    <MarkdownPreview content={skillMarkdown} />
                  ) : null}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-foreground">
                        {t("skills.detail.versionHistory")}
                      </h3>
                      {isAdmin && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          // Until the detail loads, "latest version" is
                          // unknown — opening now would prefill from nothing.
                          disabled={!detailQuery.data}
                          onClick={() => {
                            setNewVersionOpen(true);
                            // A previous failed prefill leaves the query in
                            // error with retries off; re-opening retries it.
                            if (draftSourceQuery.isError)
                              draftSourceQuery.refetch();
                          }}
                        >
                          {t("skills.authoring.newVersion")}
                        </Button>
                      )}
                    </div>
                    {(publishVersion.isError || draftSourceQuery.isError) && (
                      <p className="text-sm text-destructive">
                        {resolveApiErrorMessage(
                          publishVersion.isError
                            ? publishVersion.error
                            : draftSourceQuery.error,
                          t,
                          i18n,
                        )}
                      </p>
                    )}
                    {detailQuery.isLoading ? (
                      <Skeleton className="h-10 w-full" />
                    ) : (
                      <ul className="space-y-1">
                        {detailQuery.data?.versions.map((version) => (
                          <li
                            key={version.version}
                            className="flex items-center gap-2 text-sm"
                          >
                            <span className="font-medium text-foreground">
                              {t("skills.detail.versionLabel", {
                                version: version.version,
                              })}
                            </span>
                            <Badge variant="outline">
                              {statusLabel(version.status)}
                            </Badge>
                            {isAdmin && version.status === "draft" && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={publishVersion.isPending}
                                onClick={() =>
                                  publishVersion.mutate({
                                    skillSlug: selectedSkill.slug,
                                    version: version.version,
                                  })
                                }
                              >
                                {t("skills.authoring.publish")}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {isAdmin && createSkillOpen && (
        <SkillEditorDialog
          slug={slug}
          mode="create-skill"
          onClose={() => setCreateSkillOpen(false)}
        />
      )}
      {/* Mounted only once the source files are loaded (or the skill has no
          versions yet), so the state initializers see the pre-fill. */}
      {isAdmin &&
        newVersionOpen &&
        selectedSkill &&
        (latestVersionNumber === null || draftSourceQuery.data) && (
          <SkillEditorDialog
            slug={slug}
            mode="new-version"
            skillSlug={selectedSkill.slug}
            initialFiles={draftSourceQuery.data?.files ?? []}
            onClose={() => setNewVersionOpen(false)}
          />
        )}
    </div>
  );
}
