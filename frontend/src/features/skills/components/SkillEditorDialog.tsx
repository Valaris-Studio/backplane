// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import type { SkillFile } from "@/types/skill";
import { useCreateSkill, useCreateSkillVersion } from "../api/use-skills";

const SKILL_MD = "SKILL.md";

interface SkillEditorDialogProps {
  slug: string;
  /** Author a brand-new skill, or draft a new version of `skillSlug`. */
  mode: "create-skill" | "new-version";
  skillSlug?: string;
  /** Pre-fill for new-version mode — the latest version's files. */
  initialFiles?: SkillFile[];
  onClose: () => void;
}

/**
 * The whole authoring surface is "edit text, submit a bundle": one SKILL.md
 * body plus optional additional files with relative paths. Name/description
 * never appear here — frontmatter is authoritative server-side. Mounted fresh
 * per open, so state initializers double as the pre-fill.
 */
export function SkillEditorDialog({
  slug,
  mode,
  skillSlug,
  initialFiles,
  onClose,
}: SkillEditorDialogProps) {
  const { t, i18n } = useTranslation();
  const [newSlug, setNewSlug] = useState("");
  const [skillMdContent, setSkillMdContent] = useState(
    () => initialFiles?.find((f) => f.path === SKILL_MD)?.content ?? "",
  );
  const [extraFiles, setExtraFiles] = useState<SkillFile[]>(
    () => initialFiles?.filter((f) => f.path !== SKILL_MD) ?? [],
  );
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // preferDetail: skill-bundle validation writes the user-actionable copy
  // into `detail` while every failure mode shares error_code
  // "validation_error" — the catalog string alone cannot say what to fix.
  const errorMessage =
    error === null
      ? null
      : resolveApiErrorMessage(error, t, i18n, { preferDetail: true });

  const createSkill = useCreateSkill(slug);
  const createVersion = useCreateSkillVersion(slug);
  const isPending = createSkill.isPending || createVersion.isPending;
  const isCreateMode = mode === "create-skill";

  function updateExtraFile(index: number, patch: Partial<SkillFile>) {
    setExtraFiles((prev) =>
      prev.map((file, i) => (i === index ? { ...file, ...patch } : file)),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAlreadyExists(false);
    const files: SkillFile[] = [
      { path: SKILL_MD, content: skillMdContent },
      ...extraFiles,
    ];
    if (isCreateMode) {
      createSkill.mutate(
        { slug: newSlug.trim(), files },
        {
          onSuccess: ({ created }) => {
            // 200 means the slug was already taken — report that honestly
            // instead of closing as if something was created.
            if (created) onClose();
            else setAlreadyExists(true);
          },
          onError: setError,
        },
      );
    } else if (skillSlug) {
      createVersion.mutate(
        { skillSlug, files },
        { onSuccess: onClose, onError: setError },
      );
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreateMode
              ? t("skills.authoring.createSkillTitle")
              : t("skills.authoring.createVersionTitle")}
          </DialogTitle>
          <DialogDescription>
            {isCreateMode
              ? t("skills.authoring.createSkillDescription")
              : t("skills.authoring.createVersionDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isCreateMode && (
            <div className="space-y-2">
              <label
                htmlFor="skill-editor-slug"
                className="text-sm font-medium"
              >
                {t("skills.authoring.slugLabel")}
              </label>
              <Input
                id="skill-editor-slug"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder={t("skills.authoring.slugPlaceholder")}
                autoFocus
              />
            </div>
          )}
          <div className="space-y-2">
            <label
              htmlFor="skill-editor-skill-md"
              className="text-sm font-medium"
            >
              {t("skills.authoring.skillMdLabel")}
            </label>
            <Textarea
              id="skill-editor-skill-md"
              value={skillMdContent}
              onChange={(e) => setSkillMdContent(e.target.value)}
              rows={10}
            />
          </div>
          {extraFiles.map((file, index) => (
            <div key={index} className="space-y-2">
              <label
                htmlFor={`skill-editor-file-path-${index}`}
                className="text-sm font-medium"
              >
                {t("skills.authoring.pathLabel")}
              </label>
              <Input
                id={`skill-editor-file-path-${index}`}
                value={file.path}
                onChange={(e) =>
                  updateExtraFile(index, { path: e.target.value })
                }
                placeholder={t("skills.authoring.pathPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("skills.authoring.pathHint")}
              </p>
              <label
                htmlFor={`skill-editor-file-content-${index}`}
                className="text-sm font-medium"
              >
                {t("skills.authoring.fileContentLabel")}
              </label>
              <Textarea
                id={`skill-editor-file-content-${index}`}
                value={file.content}
                onChange={(e) =>
                  updateExtraFile(index, { content: e.target.value })
                }
                rows={4}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() =>
                  setExtraFiles((prev) => prev.filter((_, i) => i !== index))
                }
              >
                {t("skills.authoring.removeFile")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setExtraFiles((prev) => [...prev, { path: "", content: "" }])
            }
          >
            {t("skills.authoring.addFile")}
          </Button>
          {alreadyExists && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {t("skills.authoring.alreadyExists")}
            </p>
          )}
          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={isPending || (isCreateMode && !newSlug.trim())}
            >
              {isCreateMode
                ? t("skills.authoring.createSkill")
                : t("skills.authoring.createVersion")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
