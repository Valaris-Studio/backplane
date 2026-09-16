// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LogIn } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isApiError } from "@/lib/api-error";
import { useAuthModes } from "../api/use-auth-modes";
import { useLogin } from "../api/use-login";

// The OIDC callback redirects here with `?code=` on every failure. Codes are
// opaque by design (the backend never echoes tokens or upstream bodies), so
// they are shown verbatim for a support conversation rather than translated
// per-case. The password form's fetch errors are a separate channel below.
export function LoginPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: modes } = useAuthModes();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errorCode = searchParams.get("code");

  const passwordEnabled = Boolean(modes?.password_enabled);
  const oidcEnabled = Boolean(modes?.oidc_enabled);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // No client-side length rule: existing accounts may predate the setup
    // screen's minimum, and the server answers uniformly anyway.
    login.mutate(
      { email: email.trim(), password },
      { onSuccess: () => navigate("/", { replace: true }) },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <BrandLogo className="mx-auto h-8 w-auto" />
        <div className="space-y-1.5">
          <h1 className="text-xl font-bold tracking-tight">
            {t("auth.signInTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.signInSubtitle")}
          </p>
        </div>

        {errorCode && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("auth.signInFailed", { code: errorCode })}
          </p>
        )}

        {passwordEnabled && (
          /* noValidate: validation is handled in-app so messages are ours
             (translated) rather than the browser's. */
          <form
            onSubmit={handleSubmit}
            noValidate
            className="space-y-4 text-left"
          >
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-sm font-medium">
                {t("auth.email")}
              </label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-sm font-medium">
                {t("auth.password")}
              </label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {login.isError && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {/* The server's 401 is deliberately uniform (unknown email and
                    wrong password are indistinguishable) — mirror it as-is. */}
                {isApiError(login.error) && login.error.status === 401
                  ? t("auth.invalidCredentials")
                  : t("auth.loginFailed")}
              </p>
            )}

            <button
              type="submit"
              disabled={login.isPending}
              className={cn(buttonVariants(), "w-full")}
            >
              {t("auth.signIn")}
            </button>
          </form>
        )}

        {passwordEnabled && oidcEnabled && (
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-border" />
            {t("auth.or")}
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
        )}

        {oidcEnabled && (
          <a
            href={modes?.login_path}
            className={cn(
              buttonVariants(passwordEnabled ? { variant: "outline" } : {}),
              "inline-flex w-full gap-2",
            )}
          >
            <LogIn className="h-4 w-4" />
            {passwordEnabled ? t("auth.continueWithSso") : t("auth.signIn")}
          </a>
        )}

        {!passwordEnabled && !oidcEnabled && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("auth.signInUpstream")}
          </p>
        )}
      </div>
    </div>
  );
}
