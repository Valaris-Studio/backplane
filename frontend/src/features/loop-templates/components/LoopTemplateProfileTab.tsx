// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { Stat } from "@/components/ui/stat";
import { useLoopTemplateProfile } from "../hooks/useLoopTemplateDetail";
import { LoopTemplateProfileHeader } from "./LoopTemplateProfileHeader";
import {
  groupTools,
  TOOL_GROUP_ORDER,
  type ToolGroup,
} from "../lib/tool-groups";
import type {
  LoopTemplateProfile,
  LoopTemplateProfileRead,
} from "../api/loop-templates";

// The "profile page" body (spec §2.3/§5.1): who am I, what I do, when (not) to
// use me, what I need, my knobs, how I end/learn, and how I have DONE.
//
// Everything on this page is RELAYED from the endpoint. The frontend owns
// layout and section LABELS only — no prose lives here, so a template that
// rewrites its own profile needs no UI change.

// Prose sections in the order the spec tells the story. `kind` decides the
// renderer; there is no per-section component, so adding a section to the
// stored profile is one row here.
const PROSE_SECTIONS: {
  key: keyof LoopTemplateProfile;
  kind: "text" | "list";
}[] = [
  { key: "what_i_do", kind: "list" },
  { key: "when_to_use", kind: "text" },
  { key: "when_not_to_use", kind: "text" },
  { key: "needs_from_board", kind: "text" },
  { key: "needs_from_runner", kind: "text" },
  { key: "how_i_end", kind: "text" },
  { key: "how_i_learn", kind: "text" },
];

function Section({
  testId,
  title,
  className,
  children,
}: {
  testId: string;
  title: string;
  /** Grid placement only — a section that spans both columns passes it here. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card data-testid={testId} className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

function ProseSections({ profile }: { profile: LoopTemplateProfile }) {
  const { t } = useTranslation();

  return (
    <>
      {PROSE_SECTIONS.map(({ key, kind }) => {
        const value = profile[key];
        // An unwritten section is HIDDEN, not rendered as a blank heading —
        // and an empty array counts as unwritten, not as an empty list.
        if (kind === "list") {
          const steps = Array.isArray(value) ? value : [];
          if (steps.length === 0) return null;
          return (
            <Section
              key={key}
              testId={`loop-template-profile-section-${key}`}
              title={t(`loopTemplates.profile.sections.${key}`)}
            >
              <ol className="list-decimal space-y-1 pl-4">
                {steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </Section>
          );
        }

        const text = typeof value === "string" ? value.trim() : "";
        if (!text) return null;
        return (
          <Section
            key={key}
            testId={`loop-template-profile-section-${key}`}
            title={t(`loopTemplates.profile.sections.${key}`)}
          >
            <p className="whitespace-pre-line">{text}</p>
          </Section>
        );
      })}
    </>
  );
}

function TrackRecord({ profile }: { profile: LoopTemplateProfileRead }) {
  const { t } = useTranslation();
  const record = profile.track_record;

  // "Has it ever run?" is ITERATIONS, not boards_using: a board can be bound
  // to a template that has never executed a single iteration.
  if (record.iterations === 0) {
    return (
      <Section
        testId="loop-template-track-record-empty"
        className="md:col-span-2"
        title={t("loopTemplates.profile.sections.track_record")}
      >
        <p>{t("loopTemplates.profile.trackRecord.empty")}</p>
      </Section>
    );
  }

  return (
    <Section
      testId="loop-template-track-record"
      className="md:col-span-2"
      title={t("loopTemplates.profile.sections.track_record")}
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label={t("loopTemplates.profile.trackRecord.iterations")}
          value={record.iterations}
        />
        <Stat
          label={t("loopTemplates.profile.trackRecord.boardsUsing")}
          value={profile.boards_using}
        />
        <Stat
          label={t("loopTemplates.profile.trackRecord.spend")}
          value={record.spent_usd}
        />
        <Stat
          label={t("loopTemplates.profile.trackRecord.selfTerminations")}
          value={record.self_terminations}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {Object.entries(record.outcomes)
          .filter(([, count]) => count > 0)
          .map(([outcome, count]) => (
            <Pill key={outcome} tint="muted">
              {t(`loopTemplates.profile.outcomes.${outcome}`, {
                defaultValue: outcome,
              })}
              : {count}
            </Pill>
          ))}
      </div>
      {record.last_used_at && (
        <p className="mt-3 text-xs">
          {t("loopTemplates.profile.trackRecord.lastUsed", {
            when: formatDate(record.last_used_at),
          })}
        </p>
      )}
    </Section>
  );
}

function Rails({ rails }: { rails: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(rails);
  if (entries.length === 0) return null;

  return (
    <Section
      testId="loop-template-rails"
      title={t("loopTemplates.profile.sections.rails")}
    >
      <dl className="divide-y divide-border/60">
        {entries.map(([rail, value]) => (
          <div
            key={rail}
            data-testid={`loop-template-rail-${rail}`}
            className="flex items-center justify-between gap-3 py-2"
          >
            {/* The tooltip PANEL content lands in p3-09; the trigger and the
                key are this card's contract. */}
            <RichTooltip i18nKey={`loopTemplates.rails.${rail}`} side="right">
              <dt className="cursor-help font-mono text-xs text-foreground underline decoration-dotted underline-offset-4">
                {rail}
              </dt>
            </RichTooltip>
            <dd className="font-mono text-xs tabular-nums">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Tools({ tools }: { tools: string[] }) {
  const { t } = useTranslation();
  if (tools.length === 0) return null;
  const grouped = groupTools(tools);

  return (
    <Section
      testId="loop-template-tools"
      title={t("loopTemplates.profile.sections.tools")}
    >
      <div className="space-y-3">
        {TOOL_GROUP_ORDER.filter((group) => grouped[group].length > 0).map(
          (group: ToolGroup) => (
            <div key={group} data-testid={`loop-template-tool-group-${group}`}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
                {t(`loopTemplates.profile.toolGroups.${group}`)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {grouped[group].map((tool) => (
                  <Pill
                    key={tool}
                    tint={group === "offSwitch" ? "warning" : "muted"}
                    className="font-mono normal-case tracking-normal"
                  >
                    {tool}
                  </Pill>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </Section>
  );
}

function SetupContract({ contract }: { contract: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(contract);
  if (entries.length === 0) return null;

  return (
    <Section
      testId="loop-template-setup-contract"
      title={t("loopTemplates.profile.sections.setup_contract")}
    >
      <dl className="space-y-2">
        {entries.map(([requirement, value]) => (
          <div key={requirement} className="flex flex-wrap gap-2 text-xs">
            <dt className="font-mono text-foreground">{requirement}</dt>
            <dd className="font-mono">
              {Array.isArray(value) ? value.join(", ") : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function LoopTemplateProfileTab({
  slug,
  templateRef,
}: {
  slug: string;
  templateRef: string;
}) {
  const { t } = useTranslation();
  const { data: profile, isLoading } = useLoopTemplateProfile(
    slug,
    templateRef,
  );

  if (isLoading || !profile) {
    return (
      <div className="space-y-3" data-testid="loop-template-profile-loading">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const stored = profile.profile ?? {};

  return (
    <div className="space-y-3">
      {/* Identity comes from the DRAFT (editable, live); every section below
          is RELAYED from the profile endpoint, which computes rails, tools,
          the setup contract and the track record the draft never carries. */}
      <LoopTemplateProfileHeader
        fallbackName={profile.name}
        fallbackProfile={stored}
        tags={stored.tags ?? []}
      />

      {/* A profile PAGE, not a stack: the sections pair up from md: onward so
          the story reads in two columns instead of one long scroll. Sections
          that own a full row opt in with `md:col-span-2`. */}
      <div
        data-testid="loop-template-profile-sections"
        className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"
      >
        <ProseSections profile={stored} />
        <Rails rails={profile.rails_defaults} />
        <Tools tools={profile.tools} />
        <SetupContract contract={profile.setup_contract} />

        {profile.slots.length > 0 && (
          <Section
            testId="loop-template-slots"
            title={t("loopTemplates.profile.sections.slots")}
          >
            <p data-testid="loop-template-slot-count">
              {t("loopTemplates.profile.slotCount", {
                count: profile.slots.length,
              })}{" "}
              <Link
                className="underline underline-offset-4"
                to={`/${slug}/runner/loops/${templateRef}/slots`}
              >
                {t("loopTemplates.profile.viewSlots")}
              </Link>
            </p>
          </Section>
        )}

        <TrackRecord profile={profile} />
      </div>
    </div>
  );
}
