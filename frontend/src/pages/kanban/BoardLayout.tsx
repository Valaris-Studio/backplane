// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, useState } from "react";
import { Link, Outlet, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Bell,
  Bot,
  Check,
  Clapperboard,
  Clock,
  Columns3,
  FileText,
  FolderOpen,
  GitBranch,
  Hash,
  HeartPulse,
  Link2,
  MoreVertical,
  Settings,
  Snowflake,
  StickyNote,
} from "lucide-react";
import { useBoard } from "@/features/kanban/api/use-boards";
import {
  useBoardLoop,
  useBoardLoopSync,
} from "@/features/kanban/api/use-board-loop";
import {
  resolveLoopChipState,
  useBoardLoopStatus,
} from "@/features/kanban/api/use-board-loop-status";
import { useBoardAgentIds } from "@/features/kanban/hooks/use-board-agent-ids";
import { useViewportBoundHeight } from "@/hooks/use-viewport-bound-height";
import { useBoardHealth } from "@/features/kanban/api/use-board-health";
import { BoardLoopPanel } from "@/features/kanban/components/loop-template/BoardLoopPanel";
import { BoardLoopStatusChip } from "@/features/kanban/components/BoardLoopStatusChip";
import { BoardSettingsDialog } from "@/features/kanban/components/BoardSettingsDialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { TabNav } from "@/components/layout/TabNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { copyTextToClipboard } from "@/lib/clipboard";

const boardTabs = [
  { label: "boardTabs.kanban", path: "kanban", icon: Columns3, tooltipKey: "nav.boardTabs.kanban" },
  { label: "boardTabs.definitions", path: "definitions", icon: FileText, tooltipKey: "nav.boardTabs.definitions" },
  { label: "boardTabs.resources", path: "resources", icon: FolderOpen, tooltipKey: "nav.boardTabs.resources" },
  { label: "boardTabs.notes", path: "notes", icon: StickyNote, tooltipKey: "nav.boardTabs.notes" },
  { label: "boardTabs.history", path: "history", icon: Clock, tooltipKey: "nav.boardTabs.history" },
  { label: "boardTabs.timeline", path: "timeline", icon: Clapperboard, tooltipKey: "nav.boardTabs.timeline" },
  { label: "boardTabs.git", path: "git", icon: GitBranch, tooltipKey: "nav.boardTabs.git" },
  { label: "boardTabs.alerts", path: "alerts", icon: Bell, tooltipKey: "nav.boardTabs.alerts" },
];

export function BoardLayout() {
  const { slug = "", boardId = "" } = useParams();
  const { t } = useTranslation();
  const { data: board, isLoading } = useBoard(slug, boardId);
  const { data: health } = useBoardHealth(slug, boardId);
  const boardAgentIds = useBoardAgentIds(slug, board?.id ?? boardId);
  // The :boardId route param also accepts the board's slug, but /loop
  // resolves UUIDs only. `useBoardLoop`'s `enabled: !!boardId` gate means an
  // empty string cleanly holds the fetch until the board resolves, so the
  // raw route param never hits the wire even during the pre-load window —
  // unlike other hooks here, this is NOT `board?.id ?? boardId`.
  //
  // `loop_configured` gates the GET /loop request. Board still loading maps
  // to false (skip) so the pre-resolution tick never fires the fetch; flag
  // absent on a loaded board (old backend) keeps today's fetch behavior.
  //
  // Kept as a warm-up for the loop dialog even though the header itself now
  // reads /loop/status: the config is what the dialog edits, and prefetching
  // it here means opening the dialog shows the real values immediately rather
  // than an empty form that fills in a beat later.
  const loopBoardId = board?.id ?? "";
  useBoardLoop(slug, loopBoardId, board ? (board.loop_configured ?? true) : false);
  // Keeps that prefetched config live off board.loop_updated even with the
  // dialog closed (an agent or safety rail can flip the loop at any time).
  // Must key on the SAME loopBoardId as useBoardLoop above and the dialog's
  // own save/state mutations — a mismatched key silently stops matching the
  // active query, and the cache goes stale without anyone noticing.
  useBoardLoopSync(slug, loopBoardId, board?.id);
  // The chip is server-driven: GET /loop/status resolves off/waiting/running/
  // parked/unattended (plus bound-vs-alive presence) in one payload, so the
  // header no longer recomputes loop state from iteration timestamps.
  const { data: loopStatus } = useBoardLoopStatus(slug, loopBoardId, board?.id);
  const loopChipState = resolveLoopChipState(loopStatus);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loopOpen, setLoopOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const boundRef = useViewportBoundHeight<HTMLDivElement>();

  // The :boardId route param also accepts the board's slug, so both copy
  // actions use the fetched board's canonical id, never the raw param.
  function copyBoardId() {
    if (!board) return;
    void copyTextToClipboard(board.id).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    });
  }

  function copyBoardLink() {
    if (!board) return;
    const url = `${window.location.origin}/${slug}/boards/${board.id}/kanban`;
    void copyTextToClipboard(url).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  // One runner driving N concurrent stages is ONE working runner, not N — see
  // useBoardAgentIds for why this is a union of two signals. BoardView scopes
  // the AgentStatusBar with the very same hook, so the header count and the
  // bar's badges always describe the same set of runners.
  // Undefined = the in-flight query hasn't answered yet; the chip stays hidden
  // rather than flashing a "0 working" it cannot yet justify (card db510916).
  const activeAgentCount = boardAgentIds?.length;

  const healthVariant = health
    ? health.health_score >= 80 ? "success" : health.health_score >= 50 ? "warning" : "destructive"
    : undefined;

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))]" />
        <Skeleton className="h-16 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
        <Skeleton className="h-[32rem] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  if (!board) {
    return <p className="text-muted-foreground">{t("boards.notFound")}</p>;
  }

  return (
    // Viewport-bound (see useViewportBoundHeight): the shell page is
    // window-scrolled by design, so without an explicit bound the columns grow
    // to content, the window scrolls, and the column headers ride off-screen.
    // Bounding here makes the per-column ScrollArea the real card scroller.
    // gap-2, not the page-section gap: the board is viewport-bound, so every
    // pixel of chrome between header, tab nav, and board is card space lost.
    <div ref={boundRef} className="flex h-full min-h-0 flex-col gap-2">
      <PageHeader
        compact
        title={
          /* flex-wrap is the escape valve for the pills' shrink-0: they keep
             their intrinsic width, so a narrow viewport must reflow BETWEEN
             whole pills rather than compressing any one of them. gap-y-1.5
             keeps the wrapped rows apart — gap-2 alone never expressed a
             y-gap while the row could not wrap. */
          <span className="flex flex-wrap items-center gap-2 gap-y-1.5">
            {board.name}
            {health && healthVariant && (
              <RichTooltip i18nKey="kanban.boardHealthBadge" side="bottom">
                <Badge variant={healthVariant} size="sm" className="gap-1.5">
                  <HeartPulse className="h-3 w-3" />
                  {health.health_score}
                </Badge>
              </RichTooltip>
            )}
            {board.is_frozen && (
              <Badge variant="info" size="sm" className="gap-1.5">
                <Snowflake className="h-3 w-3" />
                {t("kanban.frozen.badge")}
              </Badge>
            )}
            {/* One chip for the whole loop surface: it reports the server's
                resolved state AND is the way into the dialog (it replaced both
                the old read-only badge and the ghost Repeat button that used
                to sit in the actions row). Always rendered — "off" is a state
                worth seeing, and an absent badge reads the same as a badge
                that failed to load. */}
            <BoardLoopStatusChip
              state={loopChipState}
              status={loopStatus}
              onClick={() => setLoopOpen(true)}
            />
            {!!activeAgentCount && (
              <Badge variant="info" size="sm" className="gap-1.5">
                <Bot className="h-3 w-3 animate-pulse" />
                {t("agents.agentsWorking", { count: activeAgentCount })}
              </Badge>
            )}
            {board.tags?.length > 0 && (
              <span className="flex items-center gap-1.5">
                {board.tags.slice(0, 3).map((tag) => (
                  <Badge key={tag} variant="outline" size="sm">
                    {tag}
                  </Badge>
                ))}
                {board.tags.length > 3 && (
                  <span className="text-xs text-muted-foreground">
                    +{board.tags.length - 3}
                  </span>
                )}
              </span>
            )}
          </span>
        }
        description={board.description || t("boards.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label={t("boardSettings.title")}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("boards.actions.more")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={copyBoardId} closeOnClick={false}>
                  {idCopied ? (
                    <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                  ) : (
                    <Hash className="mr-2 h-4 w-4" />
                  )}
                  {idCopied ? t("boards.actions.idCopied") : t("boards.actions.copyId")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={copyBoardLink} closeOnClick={false}>
                  {linkCopied ? (
                    <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  {linkCopied ? t("boards.actions.linkCopied") : t("boards.actions.copyLink")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link to={`/${slug}/boards`}>
              <Button variant="ghost" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                {t("boards.title")}
              </Button>
            </Link>
          </div>
        }
      />
      <TabNav
        tabs={boardTabs.map((tab) => ({ ...tab, label: t(tab.label) }))}
        basePath={`/${slug}/boards/${boardId}`}
      />
      {/* overflow-y-AUTO, not hidden: the layout is viewport-bound now, so a
          tab taller than the slot (definitions, history) must scroll here —
          hidden would clip it unreachably. The kanban tab fills exactly
          (h-full) and scrolls per-column, so no scrollbar appears for it. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Per-tab boundary: a lazy board tab (kanban/definitions/…) suspends
            HERE, keeping the board header + tab nav mounted while the chunk
            loads rather than blanking via the top-level boundary. */}
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </div>

      <BoardSettingsDialog
        board={board}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <BoardLoopPanel board={board} open={loopOpen} onOpenChange={setLoopOpen} />
    </div>
  );
}
