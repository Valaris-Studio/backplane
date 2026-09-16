// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Kanban,
  MessageSquare,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  checklistCollapsedKey,
  dispatchChecklistCollapse,
  readFlag,
  welcomeSeenKey,
  writeFlag,
} from "../utils/onboarding-storage";

interface WelcomeModalProps {
  slug: string;
  /**
   * The workspace's board count, or undefined while unknown (summary loading
   * or failed). Only a KNOWN-empty workspace (=== 0) may trigger the welcome —
   * treating "unknown" as "empty" would flash the one-time modal at joiners of
   * a populated workspace on a transient error, then mark it seen forever.
   */
  boardCount: number | undefined;
}

const FEATURE_GLYPHS: { icon: LucideIcon; labelKey: string }[] = [
  { icon: Kanban, labelKey: "onboarding.welcome.glyphBoards" },
  { icon: StickyNote, labelKey: "onboarding.welcome.glyphNotes" },
  { icon: MessageSquare, labelKey: "onboarding.welcome.glyphChannels" },
  { icon: Users, labelKey: "onboarding.welcome.glyphMembers" },
];

export function WelcomeModal({ slug, boardCount }: WelcomeModalProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // One-time trigger: a KNOWN-boardless workspace whose welcome was never
  // seen. Joiners of an already-populated workspace never qualify, and an
  // unknown count (undefined) never opens.
  useEffect(() => {
    setOpen(boardCount === 0 && !readFlag(welcomeSeenKey(slug)));
  }, [slug, boardCount]);

  // EVERY close path marks the welcome seen — it never shows twice. Only the
  // explore CTA additionally collapses the checklist (which stays available).
  function close(collapseChecklist: boolean) {
    writeFlag(welcomeSeenKey(slug), true);
    if (collapseChecklist) {
      writeFlag(checklistCollapsedKey(slug), true);
      dispatchChecklistCollapse(slug);
    }
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close(false);
      }}
    >
      {/* The shared DialogContent deliberately omits role="dialog"; add it
          here so the one-time welcome is announced as a dialog. */}
      <DialogContent role="dialog" aria-modal="true" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("onboarding.welcome.title")}</DialogTitle>
          <DialogDescription>{t("onboarding.welcome.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FEATURE_GLYPHS.map(({ icon: Icon, labelKey }) => (
            <div
              key={labelKey}
              className="flex items-center gap-3 rounded-[calc(var(--radius-md))] border border-border/60 bg-[color:var(--color-surface-1)] px-3 py-2.5"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </div>
              <span className="text-sm font-medium text-foreground">
                {t(labelKey)}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs leading-relaxed text-muted-foreground">
          <Badge variant="outline">{t("onboarding.experimentalBadge")}</Badge>
          {t("onboarding.welcome.runnerFootnote")}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(true)}>
            {t("onboarding.welcome.exploreAction")}
          </Button>
          <Button onClick={() => close(false)}>
            {t("onboarding.welcome.setUpAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
