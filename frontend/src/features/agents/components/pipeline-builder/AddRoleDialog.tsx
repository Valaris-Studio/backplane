// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  LIFECYCLE_TEMPLATE_KEYS,
  type LifecycleTemplateKey,
} from "../../utils/lifecycleTemplates";

interface AddRoleDialogProps {
  open: boolean;
  existingRoles: string[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, template: LifecycleTemplateKey) => void;
}

export function AddRoleDialog({
  open,
  existingRoles,
  onOpenChange,
  onSubmit,
}: AddRoleDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<LifecycleTemplateKey>("blank");

  // Reset when reopened.
  useEffect(() => {
    if (open) {
      setName("");
      setTemplate("blank");
    }
  }, [open]);

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0 && existingRoles.includes(trimmed);
  const submitDisabled = trimmed.length === 0 || duplicate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="lifecycle-add-role-dialog">
        <DialogHeader>
          <DialogTitle>{t("pipeline.lifecycle.addRoleDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("pipeline.lifecycle.addRoleDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="lifecycle-add-role-name"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {t("pipeline.lifecycle.role.nameLabel")}
            </label>
            <Input
              id="lifecycle-add-role-name"
              data-testid="lifecycle-add-role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("pipeline.lifecycle.role.namePlaceholder")}
              autoFocus
            />
            {duplicate && (
              <p
                className="mt-1 text-xs text-destructive"
                data-testid="lifecycle-add-role-duplicate"
              >
                {t("pipeline.lifecycle.errors.duplicateRoleName", { role: trimmed })}
              </p>
            )}
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">
              {t("pipeline.lifecycle.template.label")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {LIFECYCLE_TEMPLATE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTemplate(key)}
                  data-testid={`lifecycle-template-${key}`}
                  className={cn(
                    "rounded-md border p-3 text-left text-xs transition-colors",
                    template === key
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-border/80 hover:bg-muted/50",
                  )}
                >
                  {t(`pipeline.lifecycle.template.${key}`)}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="lifecycle-add-role-submit"
            disabled={submitDisabled}
            onClick={() => {
              onSubmit(trimmed, template);
              onOpenChange(false);
            }}
          >
            {t("pipeline.lifecycle.addRoleDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
