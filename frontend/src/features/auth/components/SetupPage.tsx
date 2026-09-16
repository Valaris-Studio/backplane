// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MIN_PASSWORD_LENGTH,
  useFirstRunSetup,
  useSetupStatus,
} from "../api/use-setup-status";

// The first screen a self-hoster ever sees: a fresh instance offers to create
// its admin account (L2). Renders only while the backend reports needs_setup —
// a stale cached `true` must not strand a configured instance here.
export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: status, isError: statusUnknown } = useSetupStatus();
  const setup = useFirstRunSetup();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  if (statusUnknown || (status && !status.needs_setup)) {
    return <Navigate to="/" replace />;
  }
  if (!status) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setValidationError(t("auth.passwordMismatch"));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setValidationError(
        t("auth.passwordMinLength", { min: MIN_PASSWORD_LENGTH }),
      );
      return;
    }
    setValidationError(null);
    setup.mutate(
      { email: email.trim(), password },
      { onSuccess: () => navigate("/", { replace: true }) },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <BrandLogo className="mx-auto h-8 w-auto" />
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-bold tracking-tight">
            {t("auth.setupTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.setupSubtitle")}
          </p>
        </div>

        {/* noValidate: validation is handled above so messages are ours
            (translated, specific) rather than the browser's. */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="setup-email" className="text-sm font-medium">
              {t("auth.email")}
            </label>
            <Input
              id="setup-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="setup-password" className="text-sm font-medium">
              {t("auth.password")}
            </label>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("auth.passwordMinLength", { min: MIN_PASSWORD_LENGTH })}
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="setup-confirm" className="text-sm font-medium">
              {t("auth.confirmPassword")}
            </label>
            <Input
              id="setup-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>

          <FieldError messages={validationError ?? undefined} />
          {setup.isError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t("auth.setupFailed")}
            </p>
          )}

          <button
            type="submit"
            disabled={setup.isPending}
            className={cn(buttonVariants(), "w-full")}
          >
            {t("auth.createAccount")}
          </button>
        </form>
      </div>
    </div>
  );
}
