// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDeleteWorkspace } from "../api/use-workspaces";

interface Props {
  slug: string;
}

export function DangerZoneSection({ slug }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typedSlug, setTypedSlug] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const deleteWorkspace = useDeleteWorkspace();

  const confirmEnabled = typedSlug === slug && !deleteWorkspace.isPending;

  function reset() {
    setTypedSlug("");
    setErrorMessage(null);
  }

  function handleConfirm() {
    if (!confirmEnabled) return;
    setErrorMessage(null);
    deleteWorkspace.mutate(slug, {
      onSuccess: () => {
        setOpen(false);
        reset();
        navigate("/", { replace: true });
      },
      onError: () => {
        setErrorMessage(t("workspaces.danger.error"));
      },
    });
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <CardTitle className="text-destructive">
              {t("workspaces.danger.title")}
            </CardTitle>
            <CardDescription>
              {t("workspaces.danger.description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button
          variant="destructive"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
          {t("workspaces.danger.deleteButton")}
        </Button>
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (deleteWorkspace.isPending) return;
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workspaces.danger.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("workspaces.danger.confirmBody", { slug })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="workspace-delete-slug"
              className="text-sm font-medium"
            >
              {t("workspaces.danger.typeToConfirm", { slug })}
            </label>
            <Input
              id="workspace-delete-slug"
              value={typedSlug}
              onChange={(e) => setTypedSlug(e.target.value)}
              placeholder={slug}
              autoComplete="off"
            />
          </div>
          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={deleteWorkspace.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={!confirmEnabled}
            >
              {deleteWorkspace.isPending
                ? t("common.saving")
                : t("workspaces.danger.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
