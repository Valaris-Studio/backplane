// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CARD_TYPE_TINT, PRIORITY_TINT } from "@/features/kanban/utils/card-visuals";
import type { CardType, Priority } from "@/types/kanban";
import { cn } from "@/lib/utils";
import { humanizeCardType, humanizePriority, humanizeRole, initials } from "../utils/humanize";
import { ParticleBurst } from "./ParticleBurst";
import { useEmphasis, type SpotlightProps } from "./ReplayCard";
import type { FrameCard } from "../types";

interface Props {
  card: FrameCard;
  selected: boolean;
  onClick: () => void;
  reducedMotion: boolean;
  spotlight?: SpotlightProps;
}

export function ReplayCardDense({ card, selected, onClick, reducedMotion, spotlight }: Props) {
  const { t } = useTranslation();
  const metadataId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useEmphasis(rootRef, selected, spotlight);
  const { snapshot, legacy } = card;
  const title = snapshot.title || t("timeline.untitledCard");
  const typeLabel = humanizeCardType(snapshot.card_type, t);
  const priorityLabel = humanizePriority(snapshot.priority, t);
  const participants = snapshot.participants ?? [];
  const labels = snapshot.labels ?? [];
  const typeTint = Object.hasOwn(CARD_TYPE_TINT, snapshot.card_type)
    ? CARD_TYPE_TINT[snapshot.card_type as CardType]
    : "var(--color-muted-foreground)";
  const priorityTint = Object.hasOwn(PRIORITY_TINT, snapshot.priority)
    ? PRIORITY_TINT[snapshot.priority as Priority]
    : "var(--color-muted-foreground)";
  const metadata = [
    typeLabel,
    priorityLabel,
    ...participants.map((holder) =>
      holder.role ? `${holder.name} (${humanizeRole(holder.role, t)})` : holder.name,
    ),
    snapshot.status,
    ...labels,
  ].filter(Boolean).join(" · ");
  const active = spotlight?.active ?? false;
  const actor = active ? spotlight?.actor : null;
  const MotionDiv = reducedMotion ? "div" : motion.div;
  const motionProps = reducedMotion
    ? {}
    : {
        layout: true,
        layoutId: snapshot.id,
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: {
          layout: { type: "spring" as const, stiffness: 420, damping: 38, mass: 0.9 },
          opacity: { duration: 0.18, ease: "easeOut" as const },
        },
      };

  return (
    <Tooltip>
      <TooltipTrigger>
        <MotionDiv
          {...motionProps}
          ref={rootRef}
          data-replay-card={snapshot.id}
          data-replay-density="dense"
          role="button"
          tabIndex={0}
          aria-label={title}
          aria-describedby={metadataId}
          aria-pressed={selected}
          onClick={onClick}
          onKeyDown={(event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClick();
            }
          }}
          style={{
            backgroundColor: `color-mix(in oklab, ${typeTint} 32%, var(--color-card))`,
            borderColor: `color-mix(in oklab, ${typeTint} 65%, var(--color-border))`,
          }}
          className={cn(
            "relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-[calc(var(--radius-sm))] border shadow-soft transition-[box-shadow,filter] duration-150 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
            legacy && "border-dashed",
          )}
        >
          <span id={metadataId} className="sr-only">{metadata}</span>
          <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full" style={{ background: priorityTint }} />
          {active && spotlight!.burst ? (
            <ParticleBurst
              key={spotlight!.burstKey}
              accentToken={spotlight!.accentToken}
              reducedMotion={reducedMotion}
            />
          ) : null}
        </MotionDiv>
      </TooltipTrigger>
      <TooltipContent avoidCollisions variant="info" className="space-y-3 p-3 [overflow-wrap:anywhere]">
        <p className="font-semibold leading-snug text-foreground">{title}</p>
        <div className="flex flex-wrap gap-1.5">
          {typeLabel ? (
            <span className="rounded px-1.5 py-0.5 text-[0.65rem] font-medium" style={{ backgroundColor: `color-mix(in oklab, ${typeTint} 18%, transparent)` }}>
              {typeLabel}
            </span>
          ) : null}
          {priorityLabel ? (
            <span className="inline-flex items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[0.65rem]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: priorityTint }} />
              {priorityLabel}
            </span>
          ) : null}
        </div>
        {snapshot.status ? (
          <dl className="flex items-start justify-between gap-3 text-[0.7rem]">
            <dt className="text-muted-foreground">{t("timeline.detail.status")}</dt>
            <dd className="text-right">{snapshot.status}</dd>
          </dl>
        ) : null}
        {participants.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[0.65rem] font-medium text-muted-foreground">{t("timeline.detail.participants")}</p>
            <ul className="space-y-1.5">
              {participants.map((participant) => (
                <li key={`${participant.agent_id ?? participant.user_id}:${participant.role}`} className="flex items-center gap-2">
                  <Avatar className="h-6 w-6">
                    {participant.avatar_url ? <AvatarImage src={participant.avatar_url} alt="" /> : null}
                    <AvatarFallback className="text-[0.55rem]">{initials(participant.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-[0.7rem] font-medium">{participant.name}</p>
                    {participant.role ? <p className="text-[0.65rem] text-muted-foreground">{humanizeRole(participant.role, t)}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {labels.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[0.65rem] font-medium text-muted-foreground">{t("timeline.detail.labels")}</p>
            <div className="flex flex-wrap gap-1">
              {labels.map((label) => <span key={label} className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem]">{label}</span>)}
            </div>
          </div>
        ) : null}
        {actor && (actor.name || actor.role) ? (
          <div className="border-t border-border/70 pt-2">
            <p className="text-[0.65rem] font-medium text-muted-foreground">{t("timeline.dense.currentActor")}</p>
            <p className="mt-1 text-[0.7rem] font-medium">{actor.name}</p>
            {actor.role ? <p className="text-[0.65rem] text-muted-foreground">{humanizeRole(actor.role, t)}</p> : null}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
