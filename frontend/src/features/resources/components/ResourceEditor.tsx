// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, Trash2, X } from "lucide-react";
import { useDeleteResource, useUpdateResource } from "../api/use-resources";
import { EditorSheet } from "@/components/ui/editor-sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { Resource } from "@/types/resource";

const MAX_TAGS = 20;

interface ResourceEditorProps {
  resource: Resource;
  slug: string;
  boardId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ResourceEditor({
  resource,
  slug,
  boardId,
  open,
  onOpenChange,
}: ResourceEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(resource.name);
  const [description, setDescription] = useState(resource.description ?? "");
  const [tags, setTags] = useState<string[]>(resource.metadata?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateResource = useUpdateResource(slug, boardId);
  const deleteResource = useDeleteResource(slug, boardId);

  useEffect(() => {
    setName(resource.name);
    setDescription(resource.description ?? "");
    setTags(resource.metadata?.tags ?? []);
    setTagInput("");
  }, [resource]);

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
    // If user pastes or types a comma, split and add all segments
    if (value.includes(",")) {
      const segments = value.split(",");
      segments.slice(0, -1).forEach((s) => addTag(s));
      setTagInput(segments[segments.length - 1] ?? "");
    } else {
      setTagInput(value);
    }
  }

  function handleSave() {
    updateResource.mutate(
      {
        resourceId: resource.id,
        name,
        description: description || null,
        metadata: { tags },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function handleDelete() {
    deleteResource.mutate(resource.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        onOpenChange(false);
      },
    });
  }

  return (
    <>
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      a11yTitle={t("resources.editResource")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!name.trim() || updateResource.isPending}
          >
            {updateResource.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("resources.namePlaceholder")}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("resources.namePlaceholder")}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t("resources.description")}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("resources.descriptionPlaceholder")}
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-sm font-medium">
          {t("resources.tags")}
          <RichTooltip i18nKey="workspace.resources.tags" side="right">
            <HelpCircle
              aria-label={t("resources.tags")}
              className="h-3.5 w-3.5 text-muted-foreground"
            />
          </RichTooltip>
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

        {tags.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("resources.noTags")}</p>
        )}

        <Input
          value={tagInput}
          onChange={(e) => handleTagInputChange(e.target.value)}
          onKeyDown={handleTagKeyDown}
          placeholder={t("resources.addTag")}
          disabled={tags.length >= MAX_TAGS}
        />
      </div>
    </EditorSheet>
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={t("resources.deleteTitle")}
      description={t("resources.deleteResourceConfirm")}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      pending={deleteResource.isPending}
      onConfirm={handleDelete}
    />
    </>
  );
}
