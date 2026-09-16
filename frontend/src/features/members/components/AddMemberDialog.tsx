// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { useAddMember } from "../api/use-members";
import { useAuthModes } from "@/features/auth/api/use-auth-modes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import type { WorkspaceRole } from "@/types/member";

const ASSIGNABLE_ROLES: WorkspaceRole[] = ["member", "admin", "viewer"];

interface AddMemberDialogProps {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddMemberDialog({
  slug,
  open,
  onOpenChange,
}: AddMemberDialogProps) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [initialPassword, setInitialPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const errorMessage =
    error === null ? null : resolveApiErrorMessage(error, t, i18n);
  const addMember = useAddMember(slug);
  const { data: modes } = useAuthModes();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    addMember.mutate(
      {
        email: email.trim(),
        role,
        // Backend applies it only to accounts with no credential yet.
        ...(initialPassword ? { initial_password: initialPassword } : {}),
      },
      {
        onSuccess: () => {
          setEmail("");
          setRole("member");
          setInitialPassword("");
          setError(null);
          onOpenChange(false);
        },
        onError: setError,
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("members.addMember")}</DialogTitle>
            <DialogDescription>{t("members.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("members.emailPlaceholder")}</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("members.emailPlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                {t("members.rolePlaceholder")}
                <RichTooltip i18nKey="workspace.members.roles" side="right">
                  <HelpCircle
                    aria-label={t("members.rolePlaceholder")}
                    className="h-3.5 w-3.5 text-muted-foreground"
                  />
                </RichTooltip>
              </label>
              <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("members.rolePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`members.roles.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {modes?.password_enabled && (
              <div className="space-y-2">
                <label
                  htmlFor="member-initial-password"
                  className="text-sm font-medium"
                >
                  {t("members.initialPassword")}
                </label>
                <Input
                  id="member-initial-password"
                  type="password"
                  autoComplete="new-password"
                  value={initialPassword}
                  onChange={(e) => setInitialPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("members.initialPasswordHint")}
                </p>
              </div>
            )}
            {errorMessage ? (
              <p className="text-sm text-destructive">{errorMessage}</p>
            ) : null}
          </div>

          <div className="flex justify-end border-t border-border/70 pt-5">
            <Button type="submit" disabled={!email.trim() || addMember.isPending}>
              {t("members.addMember")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
