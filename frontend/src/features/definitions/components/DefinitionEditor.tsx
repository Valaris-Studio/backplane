// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CompletionContextWarning } from "@/features/kanban/components/CompletionContextWarning";

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, HelpCircle, Save } from "lucide-react";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { useDefinition, useUpsertDefinition } from "../api/use-definitions";
import { useBoard } from "@/features/kanban/api/use-boards";
import { FrozenActionTooltip } from "@/features/kanban/components/FrozenActionTooltip";
import { useMembers } from "@/features/members/api/use-members";
import { useChannels } from "@/features/channels/api/use-channels";
import { ExportButton } from "@/components/export/export-button";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { pulse } from "@/lib/animations";
import { formatDateTime } from "@/lib/format";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ScopeSection } from "./sections/ScopeSection";
import { ObjectivesSection } from "./sections/ObjectivesSection";
import { ExclusionsSection } from "./sections/ExclusionsSection";
import { MilestonesSection } from "./sections/MilestonesSection";
import { TechStackSection } from "./sections/TechStackSection";
import { StakeholdersSection } from "./sections/StakeholdersSection";
import { ConstraintsSection } from "./sections/ConstraintsSection";
import { DecisionsSection } from "./sections/DecisionsSection";
import { ReferencesSection } from "./sections/ReferencesSection";
import { CustomFieldsSection } from "./sections/CustomFieldsSection";
import { OverflowSection } from "./sections/OverflowSection";
import type { DefinitionContent } from "@/types/definition";
import type { WorkspaceMember } from "@/types/member";

const EMPTY_CONTENT: DefinitionContent = {
  objectives: [],
  exclusions: [],
  milestones: [],
  tech_stack: [],
  stakeholders: [],
  constraints: [],
  decisions: [],
  references: [],
  custom_fields: [],
  _overflow: {},
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// `updated_by` is a raw user id; name it like ConnectionRow's connected-by
// label. Backend User.name defaults to "" — treat an empty name as absent.
function resolveUpdaterLabel(
  userId: string,
  members: WorkspaceMember[],
): string {
  const member = members.find((m) => m.user_id === userId);
  return member?.name || member?.email || userId.slice(0, 8);
}

// Dirty-check fingerprint. Field order is stable because every edit path
// spreads the same object shape (updateContent / the EMPTY_CONTENT merge), so
// stringify comparison is sound here without a key-sorting pass.
function fingerprint(scope: string, content: DefinitionContent): string {
  return JSON.stringify({ scope, content });
}

// How long the post-save "Saved" confirmation stays up before the button
// reverts to its (now disabled) Save label.
const SAVED_FEEDBACK_MS = 1500;

type SectionKey =
  | "scope"
  | "objectives"
  | "exclusions"
  | "milestones"
  | "techStack"
  | "stakeholders"
  | "constraints"
  | "decisions"
  | "references"
  | "customFields"
  | "overflow";

export function DefinitionEditor() {
  const { t } = useTranslation();
  const { slug = "", boardId: routeBoardId = "" } = useParams();
  // Cache hit — BoardLayout already holds this query.
  const { data: board } = useBoard(slug, routeBoardId);
  // The :boardId route param also accepts the board's slug, but
  // /definitions and /definitions/export resolve UUIDs only — thread the
  // fetched board's canonical id, falling back to the route param before it
  // has loaded (matches useDefinition's own `configured` gate below, so no
  // request fires on that raw param anyway).
  const boardId = board?.id ?? routeBoardId;
  const { data: definition, isLoading } = useDefinition(slug, boardId, {
    // Board still loading maps to false (skip) so the pre-resolution tick
    // never fires the fetch; null/absent flag on a loaded board (old
    // backend) must keep fetching.
    configured: board ? (board.has_definition ?? true) : false,
  });
  const upsert = useUpsertDefinition(slug, boardId);
  const { data: members = [] } = useMembers(slug);
  const { data: channels = [] } = useChannels(slug);
  const isFrozen = board?.is_frozen === true;

  const [scope, setScope] = useState("");
  const [content, setContent] = useState<DefinitionContent>(EMPTY_CONTENT);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Fingerprint of the last state known to match the server. Empty string is a
  // sentinel no real fingerprint can equal, so a board with no definition yet
  // starts DIRTY on purpose: its seeded Start milestone is unsaved content the
  // user must be able to persist without touching anything first.
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const reducedMotion = useReducedMotion();
  // Capture the locale at mount so changing languages cannot re-seed and
  // overwrite an unsaved new definition.
  const defaultMilestoneTitle = useRef(
    t("definitions.defaultMilestoneTitle"),
  );

  useEffect(() => {
    if (definition) {
      const seeded = { ...EMPTY_CONTENT, ...definition.content };
      setScope(definition.scope);
      setContent(seeded);
      // Baseline follows the same seed the fields get — including after the
      // post-save refetch re-seeds from server truth — so "dirty" always means
      // "differs from what the server last told us".
      setSavedFingerprint(fingerprint(definition.scope, seeded));
    } else if (definition === null) {
      setScope("");
      setContent({
        ...EMPTY_CONTENT,
        milestones: [
          {
            title: defaultMilestoneTitle.current,
            date: todayISO(),
            type: "start",
          },
        ],
      });
      setSavedFingerprint("");
    }
  }, [definition]);

  const isDirty = fingerprint(scope, content) !== savedFingerprint;

  function updateContent<K extends keyof DefinitionContent>(
    key: K,
    value: DefinitionContent[K],
  ) {
    setContent((prev) => ({ ...prev, [key]: value }));
  }

  function toggleSection(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleSave() {
    // Capture the payload's fingerprint at call time: the refetch triggered by
    // onSuccess re-seeds from server truth anyway, but marking the baseline
    // here makes the button settle immediately instead of flickering enabled
    // until the query round-trips.
    const savedNow = fingerprint(scope, content);
    upsert.mutate(
      { scope, content },
      {
        onSuccess: () => {
          setSavedFingerprint(savedNow);
          setJustSaved(true);
        },
      },
    );
  }

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), SAVED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <Skeleton className="h-[32rem] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  // One prop set, two mount points (header + footer bar) — they must never
  // drift apart in label, icon, or disabled reasoning. Rendered as elements
  // rather than a nested component so React doesn't remount (and re-tween)
  // the buttons on every parent render.
  const saveButtonProps = {
    onSave: handleSave,
    disabled: upsert.isPending || isFrozen || !isDirty,
    pending: upsert.isPending,
    saved: justSaved,
    reducedMotion,
  };

  const sections: { key: SectionKey; node: React.ReactNode }[] = [
    {
      key: "scope",
      node: <ScopeSection value={scope} onChange={setScope} workspaceSlug={slug} />,
    },
    {
      key: "objectives",
      node: (
        <ObjectivesSection
          items={content.objectives}
          onChange={(v) => updateContent("objectives", v)}
        />
      ),
    },
    {
      key: "exclusions",
      node: (
        <ExclusionsSection
          items={content.exclusions}
          onChange={(v) => updateContent("exclusions", v)}
        />
      ),
    },
    {
      key: "milestones",
      node: (
        <MilestonesSection
          items={content.milestones}
          onChange={(v) => updateContent("milestones", v)}
        />
      ),
    },
    {
      key: "techStack",
      node: (
        <TechStackSection
          items={content.tech_stack}
          onChange={(v) => updateContent("tech_stack", v)}
        />
      ),
    },
    {
      key: "stakeholders",
      node: (
        <StakeholdersSection
          items={content.stakeholders}
          onChange={(v) => updateContent("stakeholders", v)}
          members={members}
          channels={channels}
        />
      ),
    },
    {
      key: "constraints",
      node: (
        <ConstraintsSection
          items={content.constraints}
          onChange={(v) => updateContent("constraints", v)}
        />
      ),
    },
    {
      key: "decisions",
      node: (
        <DecisionsSection
          items={content.decisions}
          onChange={(v) => updateContent("decisions", v)}
          workspaceSlug={slug}
        />
      ),
    },
    {
      key: "references",
      node: (
        <ReferencesSection
          items={content.references}
          onChange={(v) => updateContent("references", v)}
        />
      ),
    },
    {
      key: "customFields",
      node: (
        <CustomFieldsSection
          items={content.custom_fields}
          onChange={(v) => updateContent("custom_fields", v)}
        />
      ),
    },
    ...(Object.keys(content._overflow).length > 0
      ? [
          {
            key: "overflow" as SectionKey,
            node: <OverflowSection overflow={content._overflow} />,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <CompletionContextWarning slug={slug} sourceKind="definition" sourceId={boardId} />
      <PageHeader
        slim
        title={t("definitions.title")}
        actions={
          <div className="flex items-center gap-2">
            <RichTooltip i18nKey="workspace.definitions.fields" side="bottom">
              <HelpCircle
                aria-label={t("definitions.title")}
                className="h-4 w-4 text-muted-foreground"
              />
            </RichTooltip>
            <ExportButton
              endpoint={`/workspaces/${slug}/boards/${boardId}/definitions/export`}
              defaultFilename={`${boardId}.valaris.definition.json`}
              entityLabel={t("export.entity.definition")}
            />
            <FrozenActionTooltip frozen={isFrozen}>
              <SaveButton {...saveButtonProps} />
            </FrozenActionTooltip>
          </div>
        }
      />

      <div className="space-y-4">
        {sections.map(({ key, node }) => (
          <Card key={key} className="border-border/75">
            <CardHeader
              className="cursor-pointer border-b border-border/70"
              onClick={() => toggleSection(key)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">
                    {t(`definitions.sections.${key}`)}
                  </CardTitle>
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center"
                  >
                    <InfoTooltip
                      text={t(`definitions.hints.${key}`)}
                      side="right"
                    />
                  </div>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                    collapsed[key] ? "-rotate-90" : ""
                  }`}
                />
              </div>
            </CardHeader>
            {!collapsed[key] && (
              <CardContent className="pt-[var(--card-padding)]">
                {node}
              </CardContent>
            )}
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3">
        <div className="text-sm text-muted-foreground">
          {definition
            ? t("definitions.lastUpdated", {
                user: resolveUpdaterLabel(definition.updated_by, members),
                date: formatDateTime(definition.updated_at),
              })
            : null}
        </div>
        <FrozenActionTooltip frozen={isFrozen}>
          <SaveButton {...saveButtonProps} />
        </FrozenActionTooltip>
      </div>
    </div>
  );
}

interface SaveButtonProps {
  onSave: () => void;
  disabled: boolean;
  pending: boolean;
  saved: boolean;
  reducedMotion: boolean;
}

function SaveButton({
  onSave,
  disabled,
  pending,
  saved,
  reducedMotion,
}: SaveButtonProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Pulse only on the rising edge of `saved`, and only for users who accept
  // motion — the label swap alone carries the confirmation otherwise.
  useEffect(() => {
    if (!saved || reducedMotion) return;
    const tween = pulse(buttonRef.current);
    return () => {
      tween?.kill();
    };
  }, [saved, reducedMotion]);

  return (
    <Button ref={buttonRef} onClick={onSave} disabled={disabled}>
      {saved ? (
        <Check className="h-4 w-4" />
      ) : (
        <Save className="h-4 w-4" />
      )}
      {pending
        ? t("common.saving")
        : saved
          ? t("common.saved")
          : t("common.save")}
    </Button>
  );
}
