// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArrowRight,
  Bot,
  CheckCircle2,
  Kanban,
  Layers,
  Link2,
  MessageSquare,
  MoveHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Rocket,
  StickyNote,
  Trash2,
  Unlink,
  Upload,
  UserMinus,
  UserPlus,
  XCircle,
  Zap,
} from "lucide-react";
import { CreateBoardDialog } from "@/features/kanban/components/CreateBoardDialog";
import { CreateChannelDialog } from "@/features/channels/components/CreateChannelDialog";
import { CreateNoteDialog } from "@/features/notes/components/CreateNoteDialog";
import { useDashboardSummary } from "@/features/dashboard/api/use-dashboard";
import { BoardStatsPanel } from "@/features/dashboard/components/BoardStatsPanel";
import { ActivityTrendPanel } from "@/features/dashboard/components/ActivityTrendPanel";
import { ActivityTypeFilter } from "@/features/dashboard/components/ActivityTypeFilter";
import { OnboardingChecklist } from "@/features/dashboard/components/OnboardingChecklist";
import { WelcomeModal } from "@/features/dashboard/components/WelcomeModal";
import { McpConnectionWizard } from "@/features/mcp-onboarding/McpConnectionWizard";
import { ConnectAgentCallout } from "@/features/mcp-onboarding/components/ConnectAgentCallout";
import {
  useAgentMetrics,
  useInFlightExecutions,
} from "@/features/agents/hooks/useAgentMetrics";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CountUp } from "@/components/ui/count-up";
import { WaveCard } from "@/features/visuals/components/WaveCard";
import { Skeleton } from "@/components/ui/skeleton";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { formatDate, formatPercentageSegments } from "@/lib/format";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { resolveActivityMessage } from "@/features/activity/utils/resolve-activity-message";
import type { ActivityAction, ActivityEntityType } from "@/types/activity";

const actionIcons: Record<ActivityAction, typeof Plus> = {
  created: Plus,
  updated: Pencil,
  deleted: Trash2,
  moved: MoveHorizontal,
  uploaded: Upload,
  archived: Archive,
  added_member: UserPlus,
  removed_member: UserMinus,
  dependency_added: Link2,
  dependency_removed: Unlink,
  dependencies_replaced: RefreshCw,
};

// Each stat card carries its accent only on the icon chip + left rail, NOT as a
// full-header wash. A bright tint behind the count/label (the old approach)
// bleached the foreground text in dark mode — the accent colors sit at 0.69–0.88
// lightness, too close to --color-foreground (0.94 dark) and
// --color-muted-foreground (0.72 dark) to keep contrast. Keeping the surface as
// the plain card and tinting only the chip preserves AA contrast in both modes.
const STAT_CARDS = [
  {
    key: "board_count",
    label: "nav.boards",
    icon: Kanban,
    href: "boards",
    accent: "var(--color-brand-500)",
  },
  {
    key: "card_count",
    label: "dashboard.cards",
    icon: Layers,
    href: "boards",
    accent: "var(--color-data-2)",
  },
  {
    key: "note_count",
    label: "nav.notes",
    icon: StickyNote,
    href: "notes",
    accent: "var(--color-data-5)",
  },
  {
    key: "channel_count",
    label: "nav.channels",
    icon: MessageSquare,
    href: "channels",
    accent: "var(--color-data-3)",
  },
] as const;

export function Dashboard() {
  const { slug } = useParams<{ slug: string }>();
  const { data: summary, isLoading } = useDashboardSummary(slug!);
  const { data: agents } = useAgentMetrics(slug!);
  const { data: inflightExecs } = useInFlightExecutions(slug!);
  // "Working" must be an AGENT count (distinct agent_ids with an in-flight
  // execution), comparable to the registered-agent count beside it. Counting
  // execution ROWS produced the "1 registered / 4 working" contradiction — one
  // runner driving 4 concurrent stages is still ONE working runner.
  const workingAgentCount = new Set(
    (inflightExecs ?? []).map((e) => e.agent_id),
  ).size;
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  const [boardDialogOpen, setBoardDialogOpen] = useState(false);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [mcpWizardOpen, setMcpWizardOpen] = useState(false);

  const statsRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLoading || reducedMotion) return;

    const statTween = staggerChildren(
      statsRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.06, duration: 0.24, maxStaggered: 12 },
    );
    const actionTween = staggerChildren(
      actionsRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.05, duration: 0.22, maxStaggered: 12 },
    );
    const activityTween = staggerChildren(
      activityRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.05, duration: 0.2, maxStaggered: 12 },
    );

    // progress(1) BEFORE kill: the entrances start from autoAlpha 0, so a bare
    // mid-flight kill strands elements invisible.
    return () => {
      statTween?.progress(1).kill();
      actionTween?.progress(1).kill();
      activityTween?.progress(1).kill();
    };
    // Deliberately NOT keyed on recent_activity: the mount stagger runs once
    // per load; live refetches are handled by the arrival pulse below.
  }, [isLoading, reducedMotion]);

  // Live pulse: WS-driven refetches swap recent_activity in place, so newly
  // arrived entries slide down into place with a decaying primary glow. The
  // first data render only SEEDS the seen-id set — the mount stagger above
  // owns that entrance.
  const seenActivityIdsRef = useRef<Set<string> | null>(null);
  const allActivity = useMemo(
    () => summary?.recent_activity ?? [],
    [summary?.recent_activity],
  );
  // Chips offer only the types the feed actually contains, so a selection can
  // never empty the list. A type that drops out of the feed on refetch also
  // drops its chip — clear the stale selection rather than render an empty feed.
  const feedEntityTypes = useMemo(
    () => Array.from(new Set(allActivity.map((activity) => activity.entity_type))),
    [allActivity],
  );
  const [activityTypeFilter, setActivityTypeFilter] =
    useState<ActivityEntityType | null>(null);
  const effectiveTypeFilter =
    activityTypeFilter && feedEntityTypes.includes(activityTypeFilter)
      ? activityTypeFilter
      : null;
  const visibleActivity = allActivity
    .filter(
      (activity) =>
        !effectiveTypeFilter || activity.entity_type === effectiveTypeFilter,
    )
    .slice(0, 5);
  const activityIdsKey = visibleActivity
    .map((activity) => activity.id)
    .join("|");

  useEffect(() => {
    const container = activityRef.current;
    if (isLoading || !container) return;

    const itemEls = Array.from(
      container.querySelectorAll<HTMLElement>("[data-activity-id]"),
    );
    const seenIds = seenActivityIdsRef.current;
    if (!seenIds) {
      seenActivityIdsRef.current = new Set(
        itemEls.map((el) => el.dataset.activityId ?? ""),
      );
      return;
    }

    const arrivedEls = itemEls.filter(
      (el) => !seenIds.has(el.dataset.activityId ?? ""),
    );
    itemEls.forEach((el) => seenIds.add(el.dataset.activityId ?? ""));
    if (arrivedEls.length === 0 || reducedMotion) return;

    const tweens = arrivedEls.flatMap((itemEl) => {
      // Plain opacity, never autoAlpha — visibility:hidden would drop the
      // entry from the accessibility tree mid-animation.
      const slideIn = gsap.fromTo(
        itemEl,
        { opacity: 0, y: -10 },
        {
          opacity: 1,
          y: 0,
          duration: 0.35,
          ease: "power2.out",
          clearProps: "opacity,transform",
        },
      );
      // The glow is a static color-mix box-shadow on an overlay; only its
      // OPACITY tweens — gsap cannot interpolate var()/color-mix() strings.
      const glowEl = itemEl.querySelector<HTMLElement>("[data-activity-glow]");
      const glowDecay = glowEl
        ? gsap.fromTo(
            glowEl,
            { opacity: 1 },
            {
              opacity: 0,
              duration: 1.4,
              ease: "power2.out",
              clearProps: "opacity",
            },
          )
        : null;
      return glowDecay ? [slideIn, glowDecay] : [slideIn];
    });

    return () => {
      tweens.forEach((tween) => {
        const targets = tween.targets<HTMLElement>();
        tween.kill();
        gsap.set(targets, { clearProps: "opacity,transform" });
      });
    };
    // activityIdsKey is the change signal: pulse when the visible id set shifts.
  }, [isLoading, reducedMotion, activityIdsKey]);

  function timeAgo(dateStr: string): string {
    const seconds = Math.floor(
      (Date.now() - new Date(dateStr).getTime()) / 1000,
    );
    if (seconds < 60) return t("activity.justNow");
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t("activity.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("activity.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return t("activity.daysAgo", { count: days });
    return formatDate(dateStr);
  }

  if (isLoading) return <DashboardSkeleton />;

  const isEmpty =
    summary &&
    summary.board_count === 0 &&
    summary.card_count === 0 &&
    summary.note_count === 0 &&
    summary.channel_count === 0;


  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        eyebrow={t("nav.dashboard")}
        title={t("dashboard.welcome", { slug })}
        description={t("dashboard.overview")}
        actions={
          <>
            <Button variant="surface" onClick={() => setNoteDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("dashboard.newNote")}
            </Button>
            <Button onClick={() => setBoardDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("dashboard.newBoard")}
            </Button>
          </>
        }
      />

      {/* boardCount stays undefined until the summary actually loads — the
          modal treats "unknown" as "not empty", so a failed request can't
          burn the one-time welcome. */}
      <WelcomeModal slug={slug!} boardCount={summary?.board_count} />
      <OnboardingChecklist slug={slug!} />

      {/* Above the empty/populated fork on purpose: a brand-new workspace
          renders only the EmptyState, and its owner is exactly who needs the
          MCP connection most. The callout hides itself once connected or once
          explicitly dismissed; the quick-action tile below stays as the
          permanent re-entry point. */}
      <ConnectAgentCallout slug={slug!} onConnect={() => setMcpWizardOpen(true)} />

      {isEmpty ? (
        <EmptyState
          icon={Rocket}
          title={t("dashboard.emptyTitle", { slug })}
          description={t("dashboard.emptyDescription")}
          action={
            <Button size="lg" onClick={() => setBoardDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("dashboard.createFirstBoard")}
            </Button>
          }
        />
      ) : (
        <>
          {/* Stat cards (compact 2×2) and Quick Actions share the LEFT column;
              Recent Activity owns the right one. Keeping them in one column
              means a tall activity feed no longer leaves a void under the
              stats. Everything stacks on narrow viewports. */}
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-[var(--page-section-gap)] self-start">
              <div
                ref={statsRef}
                className="grid grid-cols-2 gap-3"
              >
                {STAT_CARDS.map(({ key, label, icon: Icon, href, accent }) => (
                  <Link key={key} to={`/${slug}/${href}`} data-stagger-item>
                    <WaveCard
                      className="h-full border-border/75 transition-transform duration-200 hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-panel"
                      style={{ "--stat-accent": accent } as React.CSSProperties}
                    >
                      <CardHeader className="p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-cap)] border border-[color:color-mix(in_oklab,var(--stat-accent)_35%,var(--color-border))] bg-[color:color-mix(in_oklab,var(--stat-accent)_16%,var(--color-card))] text-[color:var(--stat-accent)] transition-transform duration-200 group-hover:scale-105">
                            <Icon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                              {t(label)}
                            </p>
                            <CardTitle className="mt-1 text-3xl tabular-nums">
                              <CountUp value={summary?.[key] ?? 0} />
                            </CardTitle>
                          </div>
                        </div>
                      </CardHeader>
                    </WaveCard>
                  </Link>
                ))}
              </div>

              <BoardStatsPanel slug={slug!} boardStats={summary?.board_stats} />

              <ActivityTrendPanel trend={summary?.activity_trend} />

              <div className="space-y-4">
                <h2 className="text-lg font-semibold text-foreground">
                  {t("dashboard.quickActions")}
                </h2>
                <div ref={actionsRef} className="grid gap-4 sm:grid-cols-2">
                  <button
                    type="button"
                    data-stagger-item
                    onClick={() => setBoardDialogOpen(true)}
                    className="text-left"
                  >
                    <ActionTile
                      icon={Kanban}
                      title={t("dashboard.newBoard")}
                      description={t("dashboard.quickActionBoardDescription")}
                    />
                  </button>
                  <button
                    type="button"
                    data-stagger-item
                    onClick={() => setNoteDialogOpen(true)}
                    className="text-left"
                  >
                    <ActionTile
                      icon={StickyNote}
                      title={t("dashboard.newNote")}
                      description={t("dashboard.quickActionNoteDescription")}
                    />
                  </button>
                  <button
                    type="button"
                    data-stagger-item
                    onClick={() => setChannelDialogOpen(true)}
                    className="text-left"
                  >
                    <ActionTile
                      icon={MessageSquare}
                      title={t("dashboard.addChannel")}
                      description={t("dashboard.quickActionChannelDescription")}
                    />
                  </button>
                  <button
                    type="button"
                    data-stagger-item
                    onClick={() => setMcpWizardOpen(true)}
                    className="text-left"
                  >
                    <ActionTile
                      icon={Plug}
                      title={t("mcpOnboarding.launchTileTitle")}
                      description={t("mcpOnboarding.launchTileDescription")}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* Title INSIDE the card (same idiom as the stat cards' internal
                labels) so this box's top edge aligns with the stat grid —
                a floating h2 above the card pushed it ~40px lower. */}
            <Card data-testid="recent-activity-card" className="overflow-hidden self-start">
              <CardContent className="p-[var(--card-padding)]">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t("dashboard.recentActivity")}
                  </p>
                  <Link
                    to={`/${slug}/history`}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t("dashboard.viewAllHistory")}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
                <ActivityTypeFilter
                  entityTypes={feedEntityTypes}
                  selected={effectiveTypeFilter}
                  onSelect={setActivityTypeFilter}
                />
                <div ref={activityRef} className="space-y-5">
                  {visibleActivity.map((activity) => {
                    const Icon = actionIcons[activity.action] || Pencil;

                    return (
                      <div
                        key={activity.id}
                        data-stagger-item
                        data-activity-id={activity.id}
                        className="group relative pl-8"
                      >
                        <div className="absolute left-3 top-0 h-full w-px bg-gradient-to-b from-primary/40 via-border to-transparent" />
                        <div className="absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="relative rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.15rem))] border border-border/70 bg-[color:var(--color-surface-1)] px-4 py-3 transition-colors duration-200 group-hover:bg-card">
                          {/* Static primary glow; the pulse tweens ONLY its
                              opacity — never the shadow string itself. */}
                          <div
                            aria-hidden="true"
                            data-activity-glow
                            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0"
                            style={{
                              boxShadow:
                                "0 0 0 1px color-mix(in oklab, var(--color-primary) 45%, transparent), 0 0 18px -6px color-mix(in oklab, var(--color-primary) 35%, transparent)",
                            }}
                          />
                          <p className="text-sm font-medium text-foreground">
                            {resolveActivityMessage(activity, t)}
                          </p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                            {timeAgo(activity.created_at)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          {agents && agents.length > 0 && (
            <AgentSummary
              slug={slug!}
              agents={agents}
              activeCount={workingAgentCount}
              t={t}
            />
          )}
        </>
      )}

      <CreateBoardDialog
        slug={slug!}
        open={boardDialogOpen}
        onOpenChange={setBoardDialogOpen}
      />
      <CreateNoteDialog
        slug={slug!}
        open={noteDialogOpen}
        onOpenChange={setNoteDialogOpen}
      />
      <CreateChannelDialog
        slug={slug!}
        open={channelDialogOpen}
        onOpenChange={setChannelDialogOpen}
      />
      <McpConnectionWizard open={mcpWizardOpen} onOpenChange={setMcpWizardOpen} />
    </div>
  );
}

function ActionTile({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Kanban;
  title: string;
  description: string;
}) {
  return (
    <WaveCard
      data-quick-action-tile
      className="h-full border-border/75 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/20 hover:shadow-panel"
    >
      <CardHeader className="gap-2">
        {/* Icon and title share the top row — the icon alone used to own a full
            row while occupying only its left edge, which cost every tile a band
            of dead vertical space. */}
        <div className="flex items-center gap-3">
          <div
            data-quick-action-icon
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary shadow-soft transition-transform duration-200 group-hover:scale-105"
          >
            <Icon className="h-4 w-4" />
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardContent className="p-0 text-sm leading-6 text-muted-foreground">
          {description}
        </CardContent>
      </CardHeader>
    </WaveCard>
  );
}

function AgentSummary({
  slug,
  agents,
  activeCount,
  t,
}: {
  slug: string;
  agents: import("@/features/agents/api/agents").AgentMetric[];
  activeCount: number;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const totalExecs = agents.reduce((s, a) => s + a.total_executions, 0);
  const completedExecs = agents.reduce((s, a) => s + a.completed_executions, 0);
  const failedExecs = agents.reduce((s, a) => s + a.failed_executions, 0);
  const successRate = totalExecs > 0 ? Math.round((completedExecs / totalExecs) * 100) : 0;
  const successRateSegments = formatPercentageSegments(successRate / 100, {
    maximumFractionDigits: 0,
  });

  return (
    <Card className="overflow-hidden border-border/75">
      <CardContent className="p-[var(--card-padding)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-cap)] bg-info/12 text-[color:var(--color-info-foreground)]">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t("dashboard.agentActivity")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("dashboard.agentCount", { count: agents.length })}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {activeCount > 0 && (
              <Badge variant="info" className="gap-1.5">
                <Bot className="h-3 w-3 animate-pulse" />
                {t("agents.agentsWorking", { count: activeCount })}
              </Badge>
            )}
            <div className="flex items-center gap-1.5 text-sm">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="tabular-nums text-foreground">
                <CountUp value={totalExecs} />
              </span>
              <span className="text-muted-foreground">{t("dashboard.executions")}</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--color-success-foreground)]" />
              <span className="tabular-nums text-foreground">
                {successRateSegments.prefix}
                <CountUp
                  value={successRate}
                  format={(value) =>
                    formatPercentageSegments(value / 100, {
                      maximumFractionDigits: 0,
                    }).number
                  }
                />
                {successRateSegments.suffix}
              </span>
            </div>
            {failedExecs > 0 && (
              <div className="flex items-center gap-1.5 text-sm">
                <XCircle className="h-3.5 w-3.5 text-destructive" />
                <span className="tabular-nums text-foreground">
                  <CountUp value={failedExecs} />
                </span>
                <span className="text-muted-foreground">{t("agents.failed")}</span>
              </div>
            )}
            <Link
              to={`/${slug}/runner/overview`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("dashboard.viewObservatory")}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-[var(--page-section-gap)]">
      <Skeleton className="h-40 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))]" />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid grid-cols-2 gap-3 self-start">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-[5.5rem] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
            />
          ))}
        </div>
        <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-44 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
          />
        ))}
      </div>
    </div>
  );
}
