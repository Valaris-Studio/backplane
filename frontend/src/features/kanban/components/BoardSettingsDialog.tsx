// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Download, Snowflake, Trash2, X } from "lucide-react";
import {
  useDeleteBoard,
  useFreezeBoard,
  useUnfreezeBoard,
  useUpdateBoard,
} from "../api/use-boards";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { useWorkspaceConfig } from "@/features/agents/hooks/useWorkspaceConfig";
import {
  useBoardSkillBindings,
  useSetSkillBinding,
  useSkill,
  useSkills,
  useUnbindSkill,
} from "@/features/skills/api/use-skills";
import type { BoardSkillBindingRow } from "@/types/skill";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Board } from "@/types/kanban";

import { LandingPolicyEditor } from "./LandingPolicyEditor";
import { useCompletionPolicyDraft } from "../api/use-completion";

const MAX_TAGS = 10;

// The done-gate override is tri-state, but `<Select>` speaks strings only —
// these sentinels round-trip through serialize/deserialize below. "inherit"
// deserializes to an explicit `null`, which the PATCH must actually SEND (an
// omitted key means "no change" server-side).
const GATE_INHERIT = "inherit";
const GATE_ENFORCED = "enforced";
const GATE_OFF = "off";

function serializeGate(value: boolean | null | undefined): string {
  if (value === true) return GATE_ENFORCED;
  if (value === false) return GATE_OFF;
  return GATE_INHERIT;
}

function deserializeGate(value: string): boolean | null {
  if (value === GATE_ENFORCED) return true;
  if (value === GATE_OFF) return false;
  return null;
}

// Same string-only `<Select>` constraint as the gate sentinels above: this
// sentinel deserializes to an explicit `pinned_version: null`, which the PUT
// must actually SEND (an omitted key means "unchanged" server-side).
const PIN_LATEST = "latest";

/** Version pin for one bound skill. Enumerates the skill's PUBLISHED versions
 * from its detail — pinning a draft or archived version is never offered. */
function SkillBindingPinSelect({
  slug,
  binding,
  disabled,
  onPin,
}: {
  slug: string;
  binding: BoardSkillBindingRow;
  disabled: boolean;
  onPin: (pinnedVersion: number | null) => void;
}) {
  const { t } = useTranslation();
  const detailQuery = useSkill(slug, binding.slug);
  const publishedVersions =
    detailQuery.data?.versions.filter((v) => v.status === "published") ?? [];
  const pinValue =
    binding.pinned_version === null
      ? PIN_LATEST
      : String(binding.pinned_version);
  return (
    <Select
      value={pinValue}
      onValueChange={(next) =>
        onPin(next === PIN_LATEST ? null : Number(next))
      }
    >
      <SelectTrigger
        aria-label={t("skills.boardSection.pinLabel")}
        className="h-8 w-auto"
        disabled={disabled}
      >
        <SelectValue>
          {binding.pinned_version === null
            ? t("skills.boardSection.pinLatest")
            : t("skills.detail.versionLabel", {
                version: binding.pinned_version,
              })}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PIN_LATEST}>
          {t("skills.boardSection.pinLatest")}
        </SelectItem>
        {publishedVersions.map((version) => (
          <SelectItem key={version.version} value={String(version.version)}>
            {t("skills.detail.versionLabel", { version: version.version })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface Props {
  board: Board;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BoardSettingsDialog({ board, open, onOpenChange }: Props) {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const policy = useCompletionPolicyDraft(slug, board.id, open);
  const updateBoard = useUpdateBoard(slug);
  const deleteBoard = useDeleteBoard(slug);
  const { isAdmin, role, isLoading: adminLoading } = useWorkspaceAdmin(slug);
  const { data: workspaceConfig } = useWorkspaceConfig(slug);
  const freezeBoard = useFreezeBoard(slug, board.id);
  const unfreezeBoard = useUnfreezeBoard(slug, board.id);

  // Bindings are an admin-only surface server-side (like the done gate), so
  // members never fetch them — the section is hidden for them anyway.
  const skillsQuery = useSkills(slug, { enabled: open && isAdmin });
  // RAW bindings, not the effective set: a disabled or draft-only binding is
  // absent from the effective set, which would render it as no binding at all
  // — unchecked and with no way to remove it.
  const boardSkillsQuery = useBoardSkillBindings(slug, board.id, {
    enabled: open && isAdmin,
  });
  const setSkillBinding = useSetSkillBinding(slug, board.id);
  const unbindSkill = useUnbindSkill(slug, board.id);
  const skillRowsMutating =
    setSkillBinding.isPending ||
    unbindSkill.isPending ||
    boardSkillsQuery.isRefetching;
  const workspaceSkills = skillsQuery.data?.skills ?? [];
  const boardSkillBindings = boardSkillsQuery.data?.bindings ?? [];

  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description);
  const [tags, setTags] = useState<string[]>(board.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [doneGate, setDoneGate] = useState(
    serializeGate(board.enforce_done_merge_gate),
  );

  useEffect(() => {
    setName(board.name);
    setDescription(board.description);
    setTags(board.tags ?? []);
    setTagInput("");
    setConfirmDelete(false);
    setDoneGate(serializeGate(board.enforce_done_merge_gate));
  }, [board, open]);

  function addTag(raw: string) {
    const value = raw.trim().toLowerCase();
    if (!value || tags.includes(value) || tags.length >= MAX_TAGS) return;
    setTags((prev) => [...prev, value]);
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
      setTagInput("");
    }
  }

  function handleTagInputChange(value: string) {
    if (value.includes(",")) {
      const segments = value.split(",");
      segments.slice(0, -1).forEach((s) => addTag(s));
      setTagInput(segments[segments.length - 1] ?? "");
    } else {
      setTagInput(value);
    }
  }

  // The Inherit option names what inheriting currently RESOLVES to, so the
  // operator doesn't have to open workspace settings to find out. An unloaded
  // config reads as off — same fail-closed default the consumers use.
  function gateLabel(value: string): string {
    if (value === GATE_ENFORCED) return t("boardSettings.doneGate.enforced");
    if (value === GATE_OFF) return t("boardSettings.doneGate.off");
    return workspaceConfig?.enforce_done_merge_gate === true
      ? t("boardSettings.doneGate.inheritEnforced")
      : t("boardSettings.doneGate.inheritOff");
  }

  // Mirrors the hydration effect field for field. `tagInput` and
  // `confirmDelete` are excluded: a half-typed tag was never committed, and the
  // delete confirm is UI state, not user content.
  const isDirty = useMemo(() => {
    const originalTags = board.tags ?? [];
    return (
      name.trim() !== board.name ||
      description.trim() !== board.description ||
      tags.length !== originalTags.length ||
      tags.some((tag, index) => tag !== originalTags[index]) ||
      doneGate !== serializeGate(board.enforce_done_merge_gate)
    );
  }, [board, name, description, tags, doneGate]);

  const guard = useUnsavedChangesGuard({
    isDirty: isDirty || policy.dirty,
    onClose: () => onOpenChange(false),
    onSave: () => handleSave(),
    canSave: !updateBoard.isPending && Boolean(name.trim()) && policy.canSave,
  });

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim() || !policy.canSave || !(await policy.persist())) return;
    updateBoard.mutate(
      {
        boardId: board.id,
        name: name.trim(),
        description: description.trim(),
        tags,
        // Admin-only FIELD server-side: a member including it at all gets a
        // 403 that would fail their otherwise-valid rename. Only admins see
        // the control, so only admins send the key.
        ...(isAdmin && !policy.explicit
          ? { enforce_done_merge_gate: deserializeGate(doneGate) }
          : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function handleDelete() {
    // Leave the board route BEFORE firing the delete, so the board-detail query
    // observer is already unmounted when the mutation's cache teardown runs.
    // Tearing down a query that still has a mounted observer reads as a fresh
    // mount to React Query, which refetches immediately and 404s on the board
    // being deleted (pinned by the console-clean e2e gate).
    //
    // closeAnyway, not the guarded path: deleting the board is a deliberate
    // act, not a discarded edit — and this close must not be deferred behind a
    // prompt, because the navigate() below depends on it having happened.
    guard.closeAnyway();
    navigate(`/${slug}/boards`);
    deleteBoard.mutate(board.id, {
      // Navigation already happened, so a failed delete must say so out here —
      // the dialog that would have shown the error is gone.
      onError: () => toast.error(t("boardSettings.deleteFailed")),
    });
  }

  return (
    <Dialog open={open} onOpenChange={guard.handleOpenChange}>
      {/* Same resizable contract as the loop-config dialogs, so the two board
          panels are grabbed and sized the same way. */}
      <DialogContent
        className="sm:max-w-lg"
        resizable
        resizeStorageKey="board-settings"
        defaultWidth={896}
        minWidth={672}
        maxWidth={1400}
        resizeHandleLabel={t("common.resizePanel")}
      >
        <UnsavedChangesPrompt
          open={guard.guardOpen}
          canSave={guard.canSave}
          onSave={guard.saveAndClose}
          onDiscard={guard.closeAnyway}
          onKeepEditing={guard.dismissGuard}
        />
        <form onSubmit={handleSave} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("boardSettings.title")}</DialogTitle>
            <DialogDescription>{t("boardSettings.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("boardSettings.nameLabel")}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("createBoard.namePlaceholder")}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("common.descriptionOptional")}
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("createBoard.descriptionPlaceholder")}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("boardSettings.tagsLabel")}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {tags.length}/{MAX_TAGS}
                </span>
              </label>

              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              <Input
                value={tagInput}
                onChange={(e) => handleTagInputChange(e.target.value)}
                onKeyDown={handleTagKeyDown}
                placeholder={t("boardSettings.addTagPlaceholder")}
                disabled={tags.length >= MAX_TAGS}
              />
            </div>
          </div>

          {isAdmin && policy.current.isSuccess && <LandingPolicyEditor slug={slug} boardId={board.id} value={policy.value} onChange={policy.onChange} onApply={() => void handleSave()} hideApply disabled={updateBoard.isPending || policy.isPending} />}
          {isAdmin && policy.current.isError && <div role="status" className="space-y-2 text-sm text-destructive"><p>{t("completionPolicy.previewFailed")}</p><Button type="button" size="sm" variant="outline" onClick={() => void policy.current.refetch()}>{t("completionPolicy.reload")}</Button></div>}
          {isAdmin && policy.error && <p role="alert" className="text-sm text-destructive">{t("completionPolicy.saveFailed")}</p>}
          {isAdmin && policy.explicit && <p className="text-xs text-muted-foreground">{t("completionPolicy.legacyGateHint")}</p>}
          {/* Admin-gated like freeze below: the field is admin-only server-side,
              so a member seeing the control could only ever earn a 403. */}
          {isAdmin && !adminLoading && !policy.explicit && (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40 p-3">
              <label className="text-sm font-medium">
                {t("boardSettings.doneGate.label")}
              </label>
              <Select value={doneGate} onValueChange={setDoneGate}>
                <SelectTrigger
                  aria-label={t("boardSettings.doneGate.label")}
                  className="h-9 w-full"
                >
                  <SelectValue>{gateLabel(doneGate)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GATE_INHERIT}>
                    {gateLabel(GATE_INHERIT)}
                  </SelectItem>
                  <SelectItem value={GATE_ENFORCED}>
                    {gateLabel(GATE_ENFORCED)}
                  </SelectItem>
                  <SelectItem value={GATE_OFF}>{gateLabel(GATE_OFF)}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("boardSettings.doneGate.hint")}
              </p>
            </div>
          )}

          {/* Admin-gated like the done gate above: binding writes are
              admin-only server-side. Toggles PUT immediately — bindings are
              their own resource, not part of the board PATCH this form saves. */}
          {isAdmin && !adminLoading && (
            <div className="space-y-3 rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40 p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t("skills.boardSection.title")}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("skills.boardSection.hint")}
                </p>
              </div>
              {workspaceSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("skills.boardSection.empty")}
                </p>
              ) : (
                <div className="space-y-2">
                  {/* One shared flag for all three row controls: a click
                      landing between a mutation settling and the bindings
                      refetch landing would act on the stale cache (a pin PUT
                      echoing a pre-toggle `enabled`, a toggle resurrecting a
                      just-removed binding). isRefetching, not isFetching, so
                      the initial load doesn't lock the rows. */}
                  {workspaceSkills.map((skill) => {
                    const binding = boardSkillBindings.find(
                      (b) => b.slug === skill.slug,
                    );
                    return (
                      <div key={skill.id} className="space-y-1">
                        <div className="flex items-center justify-between gap-3">
                          <Checkbox
                            checked={binding?.enabled ?? false}
                            disabled={skillRowsMutating}
                            onCheckedChange={(checked) =>
                              // pinned_version deliberately OMITTED: the
                              // server treats an absent key as "unchanged",
                              // which is what lets a pin survive
                              // disable/enable cycles.
                              setSkillBinding.mutate({
                                skillSlug: skill.slug,
                                enabled: checked,
                              })
                            }
                            label={skill.name}
                          />
                          {binding && (
                            <div className="flex shrink-0 items-center gap-2">
                              <SkillBindingPinSelect
                                slug={slug}
                                binding={binding}
                                disabled={skillRowsMutating}
                                onPin={(pinnedVersion) =>
                                  setSkillBinding.mutate({
                                    skillSlug: skill.slug,
                                    enabled: binding.enabled,
                                    pinned_version: pinnedVersion,
                                  })
                                }
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                disabled={skillRowsMutating}
                                onClick={() => unbindSkill.mutate(skill.slug)}
                              >
                                {t("skills.boardSection.remove")}
                              </Button>
                            </div>
                          )}
                        </div>
                        {binding && (
                          <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                            <span>
                              {binding.enabled
                                ? t("skills.boardSection.stateBound")
                                : t("skills.boardSection.stateBoundDisabled")}
                            </span>
                            {binding.resolved_version !== null && (
                              <span>
                                {t("skills.boardSection.resolvedVersion", {
                                  version: binding.resolved_version,
                                })}
                              </span>
                            )}
                            {/* Chips come from the BINDING row (the resolved
                                or pinned version's hand), never from the
                                workspace skill's latest version — a pinned
                                board can differ. `?? []`: rows predating the
                                field must still render. */}
                            {(binding.toolsets ?? []).map((toolsetId) => (
                              <Badge
                                key={toolsetId}
                                variant="secondary"
                                data-testid="skill-toolset-chip"
                              >
                                {toolsetId}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {binding &&
                          (binding.uncovered_toolsets ?? []).length > 0 && (
                            <p
                              role="status"
                              data-testid="skill-uncovered-banner"
                              className="ml-6 rounded-[var(--radius-md)] border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                            >
                              {t("skills.boardSection.uncoveredBanner", {
                                toolsets: binding.uncovered_toolsets.join(", "),
                              })}{" "}
                              {t("skills.boardSection.uncoveredHint")}
                            </p>
                          )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Freeze/unfreeze live here rather than the board header — operator
              levers, not daily actions. Freeze is admin+, unfreeze owner-only
              (mirrors the backend endpoints; the frozen banner offers unfreeze
              too). */}
          {isAdmin && !adminLoading && !board.is_frozen && (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40 p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("boardSettings.freezeHint")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={freezeBoard.isPending}
                onClick={() =>
                  freezeBoard.mutate(undefined, {
                    onSuccess: () => onOpenChange(false),
                  })
                }
              >
                <Snowflake className="h-4 w-4" />
                {t("kanban.frozen.freeze")}
              </Button>
            </div>
          )}
          {role === "owner" && !adminLoading && board.is_frozen && (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-sky-300/60 bg-sky-50/60 p-3 dark:border-sky-800/60 dark:bg-sky-950/30">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("boardSettings.unfreezeHint")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={unfreezeBoard.isPending}
                onClick={() =>
                  unfreezeBoard.mutate(undefined, {
                    onSuccess: () => onOpenChange(false),
                  })
                }
              >
                <Snowflake className="h-4 w-4" />
                {t("kanban.frozen.unfreeze")}
              </Button>
            </div>
          )}

          <DialogFooter className="flex-col gap-3 border-t border-border/70 pt-5 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-2">
              {!confirmDelete ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("boardSettings.deleteBoard")}
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleteBoard.isPending}
                  >
                    {deleteBoard.isPending
                      ? t("common.loading")
                      : t("boardSettings.confirmDelete")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled>
                    <Download className="h-4 w-4" />
                    {t("boardSettings.export")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("boardSettings.exportSoon")}
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={updateBoard.isPending || !name.trim() || !policy.canSave}
              >
                {updateBoard.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
