// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioWaveform, Link2, Lock, type LucideIcon } from "lucide-react";
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
import { readFlag, writeFlag } from "@/features/dashboard/utils/onboarding-storage";
import { useCompanionEnabled } from "../api/use-sessions";
import { useCompanionDevices } from "../api/use-linked-sessions";
import { GetCompanion } from "./GetCompanion";

// Per browser, not per workspace: the announcement is about the person's own
// computers, so seeing it in one workspace answers it for all of them.
export const COMPANION_ANNOUNCEMENT_SEEN_KEY = "valaris:companionAnnouncement:seen";

const HIGHLIGHTS: { icon: LucideIcon; titleKey: string; bodyKey: string }[] = [
  { icon: AudioWaveform, titleKey: "sessions.announcement.captureTitle", bodyKey: "sessions.announcement.captureBody" },
  { icon: Link2, titleKey: "sessions.announcement.linkedTitle", bodyKey: "sessions.announcement.linkedBody" },
  { icon: Lock, titleKey: "sessions.announcement.privateTitle", bodyKey: "sessions.announcement.privateBody" },
];

interface CompanionAnnouncementProps {
  // undefined while unknown. Only a KNOWN-established workspace qualifies: an
  // empty one belongs to the welcome modal, and the two must never stack.
  boardCount: number | undefined;
}

export function CompanionAnnouncement({ boardCount }: CompanionAnnouncementProps) {
  const { t } = useTranslation();
  const companionEnabled = useCompanionEnabled() === true;
  const [seen, setSeen] = useState(() => readFlag(COMPANION_ANNOUNCEMENT_SEEN_KEY));
  const eligible = companionEnabled && !!boardCount && !seen;
  const devices = useCompanionDevices(eligible);
  // A failed or unknown device answer never opens it: a person who already
  // runs Companion must not be told about it on a transient error.
  const hasNoPairedComputer = devices.isSuccess && !devices.data.some((device) => !device.revoked_at);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (eligible && hasNoPairedComputer) setOpen(true);
  }, [eligible, hasNoPairedComputer]);

  // EVERY close path marks it seen, so it shows at most once.
  function close() {
    writeFlag(COMPANION_ANNOUNCEMENT_SEEN_KEY, true);
    setSeen(true);
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {/* The shared DialogContent omits role="dialog"; add it so the
          announcement is announced as a dialog. */}
      <DialogContent role="dialog" aria-modal="true" className="max-w-lg">
        <DialogHeader>
          <Badge variant="outline" className="w-fit">
            {t("sessions.announcement.badge")}
          </Badge>
          <DialogTitle>{t("sessions.announcement.title")}</DialogTitle>
          <DialogDescription>{t("sessions.announcement.description")}</DialogDescription>
        </DialogHeader>

        <ul className="grid gap-2.5">
          {HIGHLIGHTS.map(({ icon: Icon, titleKey, bodyKey }) => (
            <li
              key={titleKey}
              className="flex items-start gap-3 rounded-[calc(var(--radius-md))] border border-border/60 bg-[color:var(--color-surface-1)] px-3 py-2.5"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary">
                <Icon aria-hidden className="size-4" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-foreground">{t(titleKey)}</span>
                <span className="block text-sm text-muted-foreground">{t(bodyKey)}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Getting Companion happens right here; taking any of its links
            answers the announcement. */}
        <GetCompanion onTake={close} />

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t("sessions.announcement.notNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
