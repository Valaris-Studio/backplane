// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthModes } from "../api/use-auth-modes";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

// Sidebar-style entry for changing one's own password. Rendered only when
// the deployment offers password login — an OIDC/IAP session has no local
// credential to change.
export function ChangePasswordLink({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const { data: modes } = useAuthModes();
  const [open, setOpen] = useState(false);

  if (!modes?.password_enabled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
          collapsed && "justify-center gap-0 px-0",
        )}
      >
        <KeyRound className="h-4 w-4 shrink-0" />
        <span
          className={cn(
            "truncate transition-[width,opacity,transform] duration-200",
            collapsed && "w-0 -translate-x-2 opacity-0",
          )}
        >
          {t("auth.changePassword")}
        </span>
      </button>

      <ChangePasswordDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
