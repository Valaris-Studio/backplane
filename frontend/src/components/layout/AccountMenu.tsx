// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Key, KeyRound, LogOut, Plus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthModes } from "@/features/auth/api/use-auth-modes";
import { ChangePasswordDialog } from "@/features/auth/components/ChangePasswordDialog";
import { performLocalLogout } from "@/features/auth/local-logout";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { ApiKeyList } from "@/features/settings/components/ApiKeyList";
import { CreateApiKeyDialog } from "@/features/settings/components/CreateApiKeyDialog";
import { getInitials } from "@/lib/initials";

// Global account entry point: avatar trigger + menu with account actions.
// Both dialogs are hoisted OUTSIDE the DropdownMenu — DropdownMenuItem
// force-closes the menu on click, so anything mounted inside the menu content
// would unmount before it could open.
export function AccountMenu() {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  const { data: modes } = useAuthModes();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);

  const canChangePassword = Boolean(modes?.password_enabled);
  // Behind IAP or an authenticating proxy (both tiers off) there is nothing
  // app-level to sign out of — same rule as SignOutLink.
  const canSignOut = Boolean(
    modes && (modes.oidc_enabled || modes.password_enabled),
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("a11y.account.menu")}
          className="group shrink-0 rounded-full"
        >
          <Avatar className="h-8 w-8 transition-shadow duration-200 group-hover:ring-2 group-hover:ring-ring/40">
            {user?.avatar_url ? (
              <AvatarImage src={user.avatar_url} alt="" />
            ) : (
              <AvatarFallback>
                {getInitials(user?.name, user?.email)}
              </AvatarFallback>
            )}
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-[16rem]">
          <DropdownMenuLabel className="normal-case tracking-normal">
            <p className="truncate text-sm font-semibold text-foreground">
              {user?.name || user?.email}
            </p>
            <p className="truncate text-xs font-normal text-muted-foreground">
              {user?.email}
            </p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {canChangePassword && (
            <DropdownMenuItem onClick={() => setChangePasswordOpen(true)}>
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("auth.changePassword")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setApiKeysOpen(true)}>
            <Key className="h-4 w-4 text-muted-foreground" />
            {t("settings.apiKeysTitle")}
          </DropdownMenuItem>
          {canSignOut && (
            <>
              <DropdownMenuSeparator />
              {modes?.oidc_enabled ? (
                // When both tiers are on, the OIDC leg wins: it clears the
                // same session cookie AND ends the IdP session.
                <a
                  href={modes.logout_path}
                  className="relative flex cursor-pointer select-none items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.2rem))] px-3 py-2 text-sm outline-none transition-[background-color,color] duration-150 hover:bg-accent hover:text-accent-foreground"
                >
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                  {t("auth.signOut")}
                </a>
              ) : (
                <DropdownMenuItem onClick={performLocalLogout}>
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                  {t("auth.signOut")}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />

      <Dialog open={apiKeysOpen} onOpenChange={setApiKeysOpen}>
        {/* Three-part contract (see BoardLoopDialog): the panel is a capped
            flex column, the KEY LIST owns the scroll, and header/footer stay
            pinned however many keys accumulate. */}
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("settings.apiKeysTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.apiKeysDescription")}
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 flex-1 overflow-y-auto pr-1"
            data-testid="api-keys-scroll-region"
          >
            <ApiKeyList />
          </div>
          <DialogFooter>
            <Button onClick={() => setCreateKeyOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("settings.generateKey")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CreateApiKeyDialog open={createKeyOpen} onOpenChange={setCreateKeyOpen} />
    </>
  );
}
