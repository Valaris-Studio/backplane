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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (slug: string) => void;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const createWorkspace = useCreateWorkspace();
  const { t } = useTranslation();

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(toSlug(value));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;

    const workspace = await createWorkspace.mutateAsync({
      name: name.trim(),
      slug: slug.trim(),
    });

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
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t("createWorkspace.slugHelper", { slug: slug || "..." })}
              </p>
            </div>
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
                createWorkspace.isPending || !name.trim() || !slug.trim()
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
