// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, Copy, Plus, Repeat, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/layout/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { formatRelative } from "@/lib/date-format";
import {
  LOOP_TEMPLATE_SORTS,
  type LoopTemplateSort,
  type LoopTemplateSummary,
} from "../api/loop-templates";
import {
  useCreateLoopTemplate,
  useDuplicateLoopTemplate,
  useLoopTemplateList,
} from "../hooks/useLoopTemplateList";
import {
  LoopTemplateDuplicateDialog,
  type DuplicateChoice,
} from "./LoopTemplateDuplicateDialog";
import { ArchiveTemplateDialog } from "./ArchiveTemplateDialog";
import { resolveApiErrorMessage } from "@/lib/localized-errors";

// A new draft needs a slug and a name up front (the P1 create schema requires
// both, min_length=1). The slug is disambiguated by timestamp so clicking
// "New" twice doesn't 409 on a duplicate slug.
function newDraftBody(untitled: string) {
  return {
    slug: `untitled-loop-${Date.now().toString(36)}`,
    name: untitled,
  };
}

interface SummaryCardProps {
  template: LoopTemplateSummary;
  isAdmin: boolean;
  onOpen: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
}

function TemplateSummaryCard({
  template,
  isAdmin,
  onOpen,
  onDuplicate,
  onArchive,
}: SummaryCardProps) {
  const { t } = useTranslation();
  const { emoji, tagline } = template.profile ?? {};

  return (
    <Card
      data-testid={`loop-template-card-${template.id}`}
      className="flex h-full flex-col transition-colors hover:border-primary/40"
    >
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className="text-2xl leading-none">
            {emoji || "🔁"}
          </span>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onOpen}
              className="text-left text-sm font-semibold hover:underline"
            >
              {template.name}
            </button>
            {tagline && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {tagline}
              </p>
            )}
          </div>
          {template.is_draft && (
            <Badge
              variant="warning"
              size="sm"
              data-testid="loop-template-draft-badge"
            >
              {t("loopTemplates.library.draft")}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" size="sm">
            v{template.version}
          </Badge>
          <span>
            {t("loopTemplates.library.boardsUsing", {
              count: template.boards_using,
            })}
          </span>
          {template.last_used_at && (
            <span>
              {t("loopTemplates.library.lastUsed", {
                when: formatRelative(template.last_used_at),
              })}
            </span>
          )}
        </div>

        {isAdmin && (
          <div className="mt-auto flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDuplicate}
              data-testid={`loop-template-duplicate-${template.id}`}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {t("loopTemplates.library.duplicate")}
            </Button>
            {/* System templates are code-defined — there is no row to archive. */}
            {!template.is_system && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onArchive}
                data-testid={`loop-template-archive-${template.id}`}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {t("loopTemplates.library.archive")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function LoopTemplateLibrary() {
  const { slug = "" } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useWorkspaceAdmin(slug);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LoopTemplateSort>("name");
  const debouncedSearch = useDebouncedValue(search);

  const { data, isLoading } = useLoopTemplateList(slug, {
    q: debouncedSearch || undefined,
    sort,
  });
  const duplicate = useDuplicateLoopTemplate(slug);
  const create = useCreateLoopTemplate(slug);
  // The template being forked, held while the name prompt is open.
  const [duplicating, setDuplicating] = useState<LoopTemplateSummary | null>(
    null,
  );
  // The template pending archive, held while the confirm dialog is open.
  const [archiving, setArchiving] = useState<LoopTemplateSummary | null>(
    null,
  );

  const templates = data?.templates ?? [];
  const system = templates.filter((tpl) => tpl.is_system);
  const mine = templates.filter((tpl) => !tpl.is_system);

  function openTemplate(ref: string) {
    navigate(`/${slug}/runner/loops/${ref}`);
  }

  function handleDuplicateConfirmed(choice: DuplicateChoice) {
    if (!duplicating) return;
    duplicate.mutate(
      { ref: duplicating.id, ...choice },
      {
        onSuccess: (created) => {
          setDuplicating(null);
          openTemplate(created.id);
        },
      },
    );
  }

  function handleCreate() {
    create.mutate(newDraftBody(t("loopTemplates.library.untitled")), {
      onSuccess: (created) => openTemplate(created.id),
    });
  }

  function renderSection(
    key: "system" | "workspace",
    rows: LoopTemplateSummary[],
  ) {
    return (
      <section
        data-testid={`loop-template-section-${key}`}
        className="space-y-3"
      >
        <h2 className="text-sm font-semibold">
          {t(`loopTemplates.library.sections.${key}`)}
        </h2>
        {rows.length === 0 ? (
          <div data-testid={`loop-template-empty-${key}`}>
            <EmptyState
              icon={Repeat}
              title={t(`loopTemplates.library.empty.${key}.title`)}
              description={t(`loopTemplates.library.empty.${key}.description`)}
            />
          </div>
        ) : (
          <div
            data-testid={`loop-template-grid-${key}`}
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            {rows.map((template) => (
              <TemplateSummaryCard
                key={template.id}
                template={template}
                isAdmin={isAdmin}
                onOpen={() => openTemplate(template.id)}
                onDuplicate={() => setDuplicating(template)}
                onArchive={() => setArchiving(template)}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("loopTemplates.library.searchPlaceholder")}
            aria-label={t("loopTemplates.library.searchPlaceholder")}
            data-testid="loop-template-search"
            className="pl-8"
          />
        </div>

        <Select
          value={sort}
          onValueChange={(value) => setSort(value as LoopTemplateSort)}
        >
          <SelectTrigger
            data-testid="loop-template-sort"
            aria-label={t("loopTemplates.library.sortLabel")}
            className="w-[11rem]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOOP_TEMPLATE_SORTS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`loopTemplates.library.sort.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isAdmin && (
          <Button
            type="button"
            onClick={handleCreate}
            disabled={create.isPending}
            data-testid="loop-template-new"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("loopTemplates.library.newTemplate")}
          </Button>
        )}
      </div>

      {duplicate.isError && (
        <p
          role="alert"
          data-testid="loop-template-duplicate-error"
          className="text-sm text-destructive"
        >
          {resolveApiErrorMessage(duplicate.error, t, i18n, {
            fallbackKey: "loopTemplates.library.duplicateFailed",
          })}
        </p>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <>
          {renderSection("system", system)}
          {renderSection("workspace", mine)}
        </>
      )}

      <LoopTemplateDuplicateDialog
        open={duplicating !== null}
        onOpenChange={(next) => {
          if (!next) setDuplicating(null);
        }}
        sourceName={duplicating?.name ?? ""}
        pending={duplicate.isPending}
        onConfirm={handleDuplicateConfirmed}
      />

      <ArchiveTemplateDialog
        slug={slug}
        target={
          archiving ? { ref: archiving.id, name: archiving.name } : null
        }
        onClose={() => setArchiving(null)}
      />
    </div>
  );
}
