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
import { useCreateTeam } from "../hooks/useTeams";

interface CreateTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
}

export function CreateTeamDialog({
  open,
  onOpenChange,
  slug,
}: CreateTeamDialogProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>(null);
  const errorMessage =
    error === null ? null : resolveApiErrorMessage(error, t, i18n);
  const createTeam = useCreateTeam(slug);

  const handleClose = () => {
    onOpenChange(false);
    setName("");
    setDescription("");
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setError(null);
    createTeam.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: handleClose,
        onError: setError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("teams.create")}</DialogTitle>
          <DialogDescription>{t("teams.createDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("teams.teamName")}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("teams.teamNamePlaceholder")}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("agents.description")}
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("teams.descriptionPlaceholder")}
              rows={3}
            />
          </div>
          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || createTeam.isPending}
            >
              {createTeam.isPending ? t("common.creating") : t("teams.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
