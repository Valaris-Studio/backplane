// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Bell, BellOff, BellRing } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useNotificationChannels,
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "../api/use-notifications";
import type {
  NotificationCategory,
  NotificationPreferences as Prefs,
  RelevanceScope,
} from "../api/notifications-api";
import {
  predictMute,
  predictScope,
  predictToggle,
} from "../utils/prefs-mutations";
import { RelevanceSelector } from "./RelevanceSelector";
import { PreferenceGrid } from "./PreferenceGrid";
import { BrowserNotificationToggle } from "./BrowserNotificationToggle";

interface NotificationPreferencesProps {
  slug: string;
}

export function NotificationPreferences({ slug }: NotificationPreferencesProps) {
  const { t } = useTranslation();
  const prefsQuery = useNotificationPreferences(slug);
  const channelsQuery = useNotificationChannels();
  const update = useUpdateNotificationPreferences(slug);

  const prefs = prefsQuery.data;
  const channels = channelsQuery.data;
  const isLoading = prefsQuery.isLoading || channelsQuery.isLoading;

  // One save path for every knob: apply the optimistic prediction, fire the PUT
  // with the minimal patch, and surface a quiet "Saved"/error toast on settle.
  function save(patch: Partial<Prefs>, optimistic: Prefs) {
    update.mutate(
      { patch, optimistic },
      {
        onSuccess: () => toast.success(t("notifications.prefs.saved")),
        onError: () => toast.error(t("notifications.prefs.saveError")),
      },
    );
  }

  function handleScopeChange(scope: RelevanceScope) {
    if (!prefs || scope === prefs.relevance_scope) return;
    save({ relevance_scope: scope }, predictScope(prefs, scope));
  }

  function handleMuteChange(muted: boolean) {
    if (!prefs) return;
    save({ muted }, predictMute(prefs, muted));
  }

  function handleToggle(
    category: NotificationCategory,
    channel: string,
    value: boolean,
  ) {
    if (!prefs) return;
    const next = predictToggle(prefs, category, channel, value);
    save({ category_overrides: next.category_overrides }, next);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-primary/10">
            <BellRing className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>{t("notifications.prefs.section.title")}</CardTitle>
            <CardDescription>
              {t("notifications.prefs.section.description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !prefs || !channels ? (
          <PreferencesSkeleton />
        ) : (
          <>
            <BrowserNotificationToggle />

            <Separator />

            <RelevanceSelector
              value={prefs.relevance_scope}
              onChange={handleScopeChange}
            />

            <Separator />

            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <span className="text-sm font-medium text-foreground">
                  {t("notifications.prefs.mute.label")}
                </span>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {prefs.muted
                    ? t("notifications.prefs.mute.active")
                    : t("notifications.prefs.mute.help")}
                </p>
              </div>
              <Toggle
                variant="outline"
                size="sm"
                pressed={prefs.muted}
                onPressedChange={handleMuteChange}
                aria-label={t("notifications.prefs.mute.label")}
                className="shrink-0 gap-1.5 data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground"
              >
                {prefs.muted ? (
                  <BellOff className="h-4 w-4" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
                {t("notifications.prefs.mute.label")}
              </Toggle>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-foreground">
                  {t("notifications.prefs.grid.title")}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("notifications.prefs.grid.description")}
                </p>
              </div>
              <PreferenceGrid
                effective={prefs.effective}
                channels={channels}
                onToggle={handleToggle}
                disabled={prefs.muted}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PreferencesSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-11 w-full" />
      </div>
      <Separator />
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <div className="space-y-2 rounded-[var(--radius-md)] border border-border/60 p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={cn("flex items-center justify-between gap-4 py-1.5")}
            >
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-8 w-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
