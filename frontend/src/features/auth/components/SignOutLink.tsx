// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthModes } from "../api/use-auth-modes";
import { performLocalLogout } from "../local-logout";

// Renders only when this deployment owns the session (OIDC or local
// password). Behind IAP or an authenticating proxy there is nothing app-level
// to sign out of, so offering the control would promise something it cannot do.
export function SignOutLink({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const { data: modes } = useAuthModes();

  if (!modes || (!modes.oidc_enabled && !modes.password_enabled)) return null;

  const className = cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
    collapsed && "justify-center gap-0 px-0",
  );
  const content = (
    <>
      <LogOut className="h-4 w-4 shrink-0" />
      <span
        className={cn(
          "truncate transition-[width,opacity,transform] duration-200",
          collapsed && "w-0 -translate-x-2 opacity-0",
        )}
      >
        {t("auth.signOut")}
      </span>
    </>
  );

  // When both tiers are on, the OIDC leg wins: it clears the same session
  // cookie AND ends the IdP session; the local endpoint only does the former.
  if (modes.oidc_enabled) {
    return (
      <a href={modes.logout_path} className={className}>
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={performLocalLogout}
      className={cn(className, "w-full")}
    >
      {content}
    </button>
  );
}
