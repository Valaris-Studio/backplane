// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Link2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  SquarePen,
} from "lucide-react";
import { ChannelEditor } from "./ChannelEditor";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { useChannels } from "../api/use-channels";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { WaveCard } from "@/features/visuals/components/WaveCard";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { Skeleton } from "@/components/ui/skeleton";
import type { Channel, ChannelType } from "@/types/channel";

const channelIcons: Record<ChannelType, typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  whatsapp: MessageSquare,
  phone: Phone,
  website: Link2,
  other: MessageSquare,
};

const badgeClasses: Record<ChannelType, string> = {
  email: "bg-info/16 text-[color:var(--color-info-foreground)]",
  slack: "bg-[color:color-mix(in_oklab,var(--color-data-5)_18%,transparent)] text-[color:var(--color-data-5)]",
  whatsapp: "bg-success/16 text-[color:var(--color-success-foreground)]",
  phone: "bg-warning/24 text-[color:var(--color-warning-foreground)]",
  website: "bg-primary/14 text-primary",
  other: "bg-muted text-muted-foreground",
};

interface ChannelListProps {
  slug: string;
}

export function ChannelList({ slug }: ChannelListProps) {
  const { t } = useTranslation();
  const { data: channels, isLoading } = useChannels(slug);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const tween = staggerChildren(
      gridRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.05, duration: 0.2, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts cards at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => { tween?.progress(1).kill(); };
  }, [channels?.length, isLoading, reducedMotion]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-48 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("channels.title")}
        description={t("channels.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("channels.newChannel")}
          </Button>
        }
      />

      {!channels?.length ? (
        <EmptyState
          icon={MessageSquare}
          title={t("channels.title")}
          description={t("channels.empty")}
          action={
            <Button size="lg" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("channels.newChannel")}
            </Button>
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {channels.map((channel) => {
            const Icon = channelIcons[channel.channel_type];

            return (
              <button
                key={channel.id}
                type="button"
                data-stagger-item
                onClick={() => {
                  setSelectedChannel(channel);
                  setEditorOpen(true);
                }}
                className="text-left"
              >
                <WaveCard className="h-full border-border/75 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/20 hover:shadow-panel">
                  <CardHeader className="gap-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary shadow-soft">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-card/70 text-muted-foreground opacity-0 transition-all duration-200 group-hover:opacity-100">
                        <SquarePen className="h-4 w-4" />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="line-clamp-2 text-lg">
                          {channel.name}
                        </CardTitle>
                        <Pill className={badgeClasses[channel.channel_type]}>
                          {channel.channel_type}
                        </Pill>
                      </div>
                      <CardDescription>{channel.contact_value}</CardDescription>
                      {channel.description ? (
                        <CardDescription className="line-clamp-2">
                          {channel.description}
                        </CardDescription>
                      ) : null}
                    </div>
                  </CardHeader>
                </WaveCard>
              </button>
            );
          })}
        </div>
      )}

      <CreateChannelDialog
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {selectedChannel ? (
        <ChannelEditor
          channel={selectedChannel}
          slug={slug}
          open={editorOpen}
          onOpenChange={setEditorOpen}
        />
      ) : null}
    </div>
  );
}
