// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { useCreateWorkspace } from "../api/use-workspaces";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { isApiError } from "@/lib/api-error";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { isValidWorkspaceSlug, toWorkspaceSlug } from "../lib/workspace-slug";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (slug: string) => void;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const createWorkspace = useCreateWorkspace();
  const { t, i18n } = useTranslation();

  const trimmedSlug = slug.trim();
  const slugIsInvalid = trimmedSlug !== "" && !isValidWorkspaceSlug(trimmedSlug);
  const nameYieldsNoSlug = !slugTouched && name.trim() !== "" && trimmedSlug === "";
  const submitErrorMessage =
    submitError === null
      ? null
      : isApiError(submitError) && submitError.status === 409
        ? t("createWorkspace.slugTaken")
        : resolveApiErrorMessage(submitError, t, i18n);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(toWorkspaceSlug(value));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !trimmedSlug || slugIsInvalid) return;

    setSubmitError(null);
    let workspace;
    try {
      workspace = await createWorkspace.mutateAsync({
        name: name.trim(),
        slug: trimmedSlug,
      });
    } catch (error) {
      setSubmitError(error);
      return;
    }

    setName("");
    setSlug("");
    setSlugTouched(false);
    onOpenChange(false);
    onCreated?.(workspace.slug);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("createWorkspace.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("createWorkspace.nameLabel")}</label>
              <Input
                placeholder={t("createWorkspace.namePlaceholder")}
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                {t("createWorkspace.slugLabel")}
                <RichTooltip i18nKey="workspace.create.slug" side="right">
                  <HelpCircle
                    aria-label={t("createWorkspace.slugLabel")}
                    className="h-3.5 w-3.5 text-muted-foreground"
                  />
                </RichTooltip>
              </label>
              <Input
                placeholder={t("createWorkspace.slugPlaceholder")}
                value={slug}
                aria-invalid={slugIsInvalid}
                aria-describedby="create-workspace-slug-hint"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
              {slugIsInvalid ? (
                <p
                  id="create-workspace-slug-hint"
                  className="text-xs text-destructive"
                >
                  {t("createWorkspace.slugInvalid")}
                </p>
              ) : nameYieldsNoSlug ? (
                <p
                  id="create-workspace-slug-hint"
                  className="text-xs text-destructive"
                >
                  {t("createWorkspace.slugUnderivable")}
                </p>
              ) : (
                <p
                  id="create-workspace-slug-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t("createWorkspace.slugHelper", { slug: slug || "..." })}
                </p>
              )}
            </div>
            {submitErrorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {submitErrorMessage}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                createWorkspace.isPending ||
                !name.trim() ||
                !trimmedSlug ||
                slugIsInvalid
              }
            >
              {createWorkspace.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
