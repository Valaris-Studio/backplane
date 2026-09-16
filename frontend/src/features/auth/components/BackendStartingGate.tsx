// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useAuthModes } from "../api/use-auth-modes";
import { isApiError } from "@/lib/api-error";

// self-host first-run: compose brings frontend up before backend finishes
// `alembic upgrade head`, so the very first /auth/modes call can hit a closed
// port (network error, ApiError.status 0) or a 502/503/504 from a proxy in
// front of a not-yet-listening backend. useAuthModes has retry:false and no
// auto-refetch (it's deployment config, staleTime: Infinity), so this gate
// owns its own polling — an interval that exists ONLY while the gate is
// showing, never in steady state. Polling must not live on the shared hook:
// useAuthModes has seven consumers, and a refetchInterval there would turn
// any post-boot error blip into permanent app-wide 3s polling.
function isBackendUnreachable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;
}

export function BackendStartingGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { isError, error, refetch } = useAuthModes();

  const backendDown = isError && isBackendUnreachable(error);

  useEffect(() => {
    if (!backendDown) return;
    const id = setInterval(() => void refetch(), 3000);
    return () => clearInterval(id);
  }, [backendDown, refetch]);

  // Any other failure (401/403 from an IAP/proxy deployment where the SPA
  // never has an unauthenticated auth-modes view) must render children
  // normally -- this gate is only for "the backend isn't up yet".
  if (backendDown) {
    return (
      <div
        data-testid="backend-starting"
        className="flex min-h-screen flex-col items-center justify-center gap-3 text-center text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        <p className="text-sm font-medium text-foreground">{t("auth.backendStarting")}</p>
        <p className="text-sm">{t("auth.backendStartingSubline")}</p>
      </div>
    );
  }

  return <>{children}</>;
}
