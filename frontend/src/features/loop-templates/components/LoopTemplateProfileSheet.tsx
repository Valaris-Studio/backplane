// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLoopTemplateProfile } from "../hooks/useLoopTemplateDetail";
import { LoopTemplateProfileTab } from "./LoopTemplateProfileTab";

/**
 * The board dialog's "view profile" surface (p3-07 mounts it).
 *
 * It renders the profile TAB rather than a sheet-shaped copy of it, so the
 * profile has exactly one implementation and the sheet cannot drift from the
 * page as later cards extend either one.
 */
export function LoopTemplateProfileSheet({
  slug,
  templateRef,
  open,
  onOpenChange,
}: {
  slug: string;
  templateRef: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  // Gated on `open`: a closed sheet must not fetch the profile of every
  // template the operator merely scrolled past in the picker. `Sheet` already
  // renders nothing while closed, so this argument — not an early return — is
  // what actually suppresses the request.
  const { data: profile } = useLoopTemplateProfile(
    slug,
    open ? templateRef : "",
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle data-testid="loop-template-sheet-title">
            {profile?.profile?.emoji} {profile?.name ?? templateRef}
          </SheetTitle>
          <SheetDescription>
            {t("loopTemplates.profile.sheetDescription")}
          </SheetDescription>
        </SheetHeader>
        <LoopTemplateProfileTab slug={slug} templateRef={templateRef} />
      </SheetContent>
    </Sheet>
  );
}
