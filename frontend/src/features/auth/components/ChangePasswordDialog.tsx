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
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { isApiError } from "@/lib/api-error";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useChangePassword } from "../api/use-account";
import { MIN_PASSWORD_LENGTH } from "../api/use-setup-status";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Change-own-password form. Callers gate rendering/opening on
// `modes.password_enabled` — an OIDC/IAP session has no local credential.
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: ChangePasswordDialogProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const changePassword = useChangePassword();
  const { data: me } = useCurrentUser();

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setValidationError(null);
    changePassword.reset();
  };

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) reset();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setValidationError(t("auth.passwordMismatch"));
      return;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setValidationError(t("auth.passwordMinLength", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    setValidationError(null);
    changePassword.mutate(
      { current_password: current, new_password: next },
      { onSuccess: () => handleOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("auth.changePassword")}</DialogTitle>
            <DialogDescription>
              {t("auth.changePasswordSubtitle")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Hidden username lets password managers associate the
                new-password fields with the right account. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={me?.email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <div className="space-y-1.5">
              <label htmlFor="current-password" className="text-sm font-medium">
                {t("auth.currentPassword")}
              </label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="new-password" className="text-sm font-medium">
                {t("auth.newPassword")}
              </label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("auth.passwordMinLength", { min: MIN_PASSWORD_LENGTH })}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm-new-password" className="text-sm font-medium">
                {t("auth.confirmPassword")}
              </label>
              <Input
                id="confirm-new-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>

            <FieldError messages={validationError ?? undefined} />
            {changePassword.isError && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {isApiError(changePassword.error) &&
                changePassword.error.status === 400
                  ? t("auth.currentPasswordIncorrect")
                  : t("auth.changePasswordFailed")}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={changePassword.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
