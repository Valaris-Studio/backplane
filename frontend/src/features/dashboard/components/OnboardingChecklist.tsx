// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleCheckBig,
  CircleDashed,
  FileText,
  GitBranch,
  Kanban,
  MessageSquare,
  Minus,
  Rocket,
  Sparkles,
  StickyNote,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { dashboardKeys } from "@/lib/query-keys";
import { useBoards, useCreateBoard } from "@/features/kanban/api/use-boards";
import { useCreateCard } from "@/features/kanban/api/use-cards";
import {
  useDefinition,
  useUpsertDefinition,
} from "@/features/definitions/api/use-definitions";
import { useAddMember, useMembers } from "@/features/members/api/use-members";
import { useCreateChannel } from "@/features/channels/api/use-channels";
import {
  useCreateGitRepo,
  useGitRepos,
} from "@/features/git/api/use-git-repos";
import { useCreateNote } from "@/features/notes/api/use-notes";
import { useResources } from "@/features/resources/api/use-resources";
import type { BoardDetail } from "@/types/kanban";
import type { DefinitionContent } from "@/types/definition";
import type { WorkspaceRole } from "@/types/member";
import type { GitProvider } from "@/types/git";
import { useDashboardSummary } from "../api/use-dashboard";
import { OnboardingStepIllustration } from "./OnboardingStepIllustration";
import { OnboardingRail } from "./OnboardingRail";
import {
  CHECKLIST_COLLAPSE_EVENT,
  checklistCollapsedKey,
  checklistDismissedKey,
  readFlag,
  readSkippedSteps,
  writeFlag,
  writeSkippedSteps,
} from "../utils/onboarding-storage";

// Long enough for the final step's icon pop (0.4s) + ring pulse (0.7s) to
// finish before the all-done view replaces the checklist.
const FINAL_STEP_CELEBRATION_MS = 1100;

type StepId = "board" | "context" | "notes" | "members" | "channels" | "repos";
type StepState = "empty" | "done" | "skipped";

// `introKey` + `bulletKeys` are the modal's didactic layer: the rail pill's
// short label says WHICH area this is, the hint says WHAT the step is, and
// these say why it's worth doing and what it unlocks. Bullet count varies by
// step — foundational areas earn a third.
const STEP_ORDER: {
  id: StepId;
  icon: LucideIcon;
  labelKey: string;
  titleKey: string;
  hintKey: string;
  introKey: string;
  bulletKeys: string[];
  optional?: boolean;
}[] = [
  {
    id: "board",
    icon: Kanban,
    labelKey: "onboarding.checklist.stepBoardLabel",
    titleKey: "onboarding.checklist.stepBoardTitle",
    hintKey: "onboarding.checklist.stepBoardHint",
    introKey: "onboarding.checklist.stepBoardIntro",
    bulletKeys: [
      "onboarding.checklist.stepBoardBullet1",
      "onboarding.checklist.stepBoardBullet2",
      "onboarding.checklist.stepBoardBullet3",
    ],
  },
  {
    id: "context",
    icon: FileText,
    labelKey: "onboarding.checklist.stepContextLabel",
    titleKey: "onboarding.checklist.stepContextTitle",
    hintKey: "onboarding.checklist.stepContextHint",
    introKey: "onboarding.checklist.stepContextIntro",
    bulletKeys: [
      "onboarding.checklist.stepContextBullet1",
      "onboarding.checklist.stepContextBullet2",
      "onboarding.checklist.stepContextBullet3",
    ],
  },
  {
    id: "notes",
    icon: StickyNote,
    labelKey: "onboarding.checklist.stepNotesLabel",
    titleKey: "onboarding.checklist.stepNotesTitle",
    hintKey: "onboarding.checklist.stepNotesHint",
    introKey: "onboarding.checklist.stepNotesIntro",
    bulletKeys: [
      "onboarding.checklist.stepNotesBullet1",
      "onboarding.checklist.stepNotesBullet2",
    ],
  },
  {
    id: "members",
    icon: Users,
    labelKey: "onboarding.checklist.stepMembersLabel",
    titleKey: "onboarding.checklist.stepMembersTitle",
    hintKey: "onboarding.checklist.stepMembersHint",
    introKey: "onboarding.checklist.stepMembersIntro",
    bulletKeys: [
      "onboarding.checklist.stepMembersBullet1",
      "onboarding.checklist.stepMembersBullet2",
    ],
  },
  {
    id: "channels",
    icon: MessageSquare,
    labelKey: "onboarding.checklist.stepChannelsLabel",
    titleKey: "onboarding.checklist.stepChannelsTitle",
    hintKey: "onboarding.checklist.stepChannelsHint",
    introKey: "onboarding.checklist.stepChannelsIntro",
    bulletKeys: [
      "onboarding.checklist.stepChannelsBullet1",
      "onboarding.checklist.stepChannelsBullet2",
    ],
  },
  {
    id: "repos",
    icon: GitBranch,
    labelKey: "onboarding.checklist.stepReposLabel",
    titleKey: "onboarding.checklist.stepReposTitle",
    hintKey: "onboarding.checklist.stepReposHint",
    introKey: "onboarding.checklist.stepReposIntro",
    bulletKeys: [
      "onboarding.checklist.stepReposBullet1",
      "onboarding.checklist.stepReposBullet2",
    ],
    optional: true,
  },
];

// "Context is set" means the definition exists AND carries at least one
// populated section — an empty structured shell is not real project context.
function hasDefinitionContent(content: DefinitionContent): boolean {
  return [
    content.objectives,
    content.exclusions,
    content.milestones,
    content.tech_stack,
    content.stakeholders,
    content.constraints,
    content.decisions,
    content.references,
    content.custom_fields,
  ].some((entries) => (entries?.length ?? 0) > 0);
}

interface OnboardingChecklistProps {
  slug: string;
}

export function OnboardingChecklist({ slug }: OnboardingChecklistProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  const [dismissed, setDismissed] = useState(() =>
    readFlag(checklistDismissedKey(slug)),
  );
  const [collapsed, setCollapsed] = useState(() =>
    readFlag(checklistCollapsedKey(slug)),
  );
  const [skippedSteps, setSkippedSteps] = useState<StepId[]>(
    () => readSkippedSteps(slug) as StepId[],
  );
  // Selection outlives `dialogOpen` so the modal keeps its content while it
  // animates out — clearing both at once would blank the body mid-close.
  const [selectedStepId, setSelectedStepId] = useState<StepId | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Board created through the inline mini-form this session — its seeded
  // columns feed the optional card inputs without a second fetch.
  const [sessionBoard, setSessionBoard] = useState<BoardDetail | null>(null);

  // Each workspace tracks its own flags — re-read when the slug changes so a
  // new org still shows the full guide.
  useEffect(() => {
    setDismissed(readFlag(checklistDismissedKey(slug)));
    setCollapsed(readFlag(checklistCollapsedKey(slug)));
    setSkippedSteps(readSkippedSteps(slug) as StepId[]);
    setSelectedStepId(null);
    setDialogOpen(false);
    setSessionBoard(null);
  }, [slug]);

  // The welcome modal's "explore on my own" CTA collapses an already-mounted
  // checklist through a same-document event — writing localStorage alone
  // would not reach this component until a remount.
  useEffect(() => {
    function handleCollapse(event: Event) {
      const detail = (event as CustomEvent<{ slug?: string }>).detail;
      if (detail?.slug === slug) setCollapsed(true);
    }
    window.addEventListener(CHECKLIST_COLLAPSE_EVENT, handleCollapse);
    return () =>
      window.removeEventListener(CHECKLIST_COLLAPSE_EVENT, handleCollapse);
  }, [slug]);

  // Every done-state derives from live workspace data — never a stored step
  // cursor. Actions taken outside the wizard stay honest via the hooks' own
  // domain-sync invalidation.
  const summaryQuery = useDashboardSummary(slug);
  const boardsQuery = useBoards(slug);
  const membersQuery = useMembers(slug);
  const resourcesQuery = useResources(slug);

  const summary = summaryQuery.data;
  const boards = boardsQuery.data ?? [];
  const firstBoard = boards[0] ?? sessionBoard ?? null;
  const firstBoardId = firstBoard?.id ?? "";

  const definitionQuery = useDefinition(slug, firstBoardId, {
    enabled: !!firstBoardId,
    // null/absent (create response, old backend) must keep fetching.
    configured: firstBoard?.has_definition ?? true,
  });
  const reposQuery = useGitRepos(slug, firstBoardId, {
    enabled: !!firstBoardId,
  });

  const doneByStep: Record<StepId, boolean> = {
    board:
      (summary?.board_count ?? 0) > 0 || boards.length > 0 || !!sessionBoard,
    context:
      definitionQuery.data != null &&
      hasDefinitionContent(definitionQuery.data.content),
    notes:
      (summary?.note_count ?? 0) > 0 || (resourcesQuery.data?.length ?? 0) > 0,
    members: (membersQuery.data?.length ?? 0) >= 2,
    channels: (summary?.channel_count ?? 0) > 0,
    repos: (reposQuery.data?.length ?? 0) > 0,
  };

  const stepState = (id: StepId): StepState =>
    doneByStep[id] ? "done" : skippedSteps.includes(id) ? "skipped" : "empty";

  const allDone = STEP_ORDER.every(
    ({ id }) => doneByStep[id] || skippedSteps.includes(id),
  );

  const resolvedCount = STEP_ORDER.filter(
    ({ id }) => stepState(id) !== "empty",
  ).length;
  // The rail points at the first unresolved step so a returning user sees
  // where to continue without reading every pill.
  const activeStepId =
    STEP_ORDER.find(({ id }) => stepState(id) === "empty")?.id ?? null;

  const selectedStep =
    STEP_ORDER.find(({ id }) => id === selectedStepId) ?? null;
  // The all-done CTA needs a board to link to, so a fully-skipped-around
  // checklist without one never claims "ready".
  const showAllDoneEligible = allDone && doneByStep.board;

  // Rows must MOUNT with their true done-state (a step mounting already-done
  // gets no celebration), so hold rendering until the first load settles. The
  // ref LATCHES: later refetches or newly-enabled board-scoped queries must
  // not unmount the rows mid-session — that would swallow in-flight
  // celebrations. isPending (not isLoading) for the board-scoped pair so a
  // workspace that already has a board waits for their first resolution too.
  const boardScopedPending =
    !!firstBoardId && (definitionQuery.isPending || reposQuery.isPending);
  const settledRef = useRef(false);
  // Read BEFORE latching: the hold below must distinguish "flipped done
  // during the session" (steps were already on screen) from "settled
  // already-done" (first data render of a finished workspace).
  const wasSettledBeforeThisRender = settledRef.current;
  if (
    !summaryQuery.isLoading &&
    !boardsQuery.isLoading &&
    !membersQuery.isLoading &&
    !resourcesQuery.isLoading &&
    !boardScopedPending
  ) {
    settledRef.current = true;
  }

  // When the LAST step completes during the session, keep the checklist on
  // screen long enough for that step's celebration before swapping to the
  // all-done view. Already-all-done mounts (and reduced motion) swap
  // instantly. The transition MUST be detected during render
  // (setState-in-render pattern), not in an effect — an effect runs after the
  // all-done view has already committed, which unmounts the steps and
  // swallows the final celebration.
  const [holdChecklist, setHoldChecklist] = useState(false);
  const [prevAllDone, setPrevAllDone] = useState(showAllDoneEligible);
  if (showAllDoneEligible !== prevAllDone) {
    setPrevAllDone(showAllDoneEligible);
    if (showAllDoneEligible && !reducedMotion && wasSettledBeforeThisRender)
      setHoldChecklist(true);
  }
  useEffect(() => {
    if (!holdChecklist) return;
    const timer = window.setTimeout(
      () => setHoldChecklist(false),
      FINAL_STEP_CELEBRATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [holdChecklist]);

  if (dismissed || !settledRef.current) return null;

  const showAllDone = showAllDoneEligible && !holdChecklist;

  function handleDismiss() {
    writeFlag(checklistDismissedKey(slug), true);
    setDismissed(true);
  }

  function handleExpandPanel() {
    writeFlag(checklistCollapsedKey(slug), false);
    setCollapsed(false);
  }

  // Clicking the open step's own pill toggles it shut, matching the card
  // grid's affordance; any other pill switches the modal to that step.
  function openStep(id: StepId) {
    if (dialogOpen && selectedStepId === id) {
      setDialogOpen(false);
      return;
    }
    setSelectedStepId(id);
    setDialogOpen(true);
  }

  function closeStep() {
    setDialogOpen(false);
  }

  function skipStep(id: StepId) {
    setSkippedSteps((current) => {
      const next = current.includes(id) ? current : [...current, id];
      writeSkippedSteps(slug, next);
      return next;
    });
  }

  function revisitStep(id: StepId) {
    setSkippedSteps((current) => {
      const next = current.filter((step) => step !== id);
      writeSkippedSteps(slug, next);
      return next;
    });
  }

  if (collapsed) {
    return (
      <Card
        data-onboarding-checklist
        className="border-primary/25 bg-[color:var(--color-surface-1)]"
      >
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/15 text-primary">
              <Rocket className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {t("onboarding.checklist.title")}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={handleExpandPanel}
            aria-label={t("onboarding.checklist.expandAria")}
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card
      data-onboarding-checklist
      className={cn(
        // Same two-mode wash as the old FirstRunPanel: warm brand tint on
        // light, primary-tinted darkening on dark (a bright pastel band
        // bleaches white text on the dark canvas).
        "border-primary/25 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-brand-100)_48%,transparent),transparent)]",
        "dark:border-primary/20 dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-primary)_10%,transparent),transparent)] dark:shadow-none",
      )}
    >
      <CardContent className="p-[var(--card-padding)]">
        {/* Header is its own row so the rail below can span the card's FULL
            width — the old layout indented the steps beside this tile. */}
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/15 text-primary">
              {showAllDone ? (
                <Sparkles className="h-5 w-5" />
              ) : (
                <Rocket className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
                {showAllDone
                  ? t("onboarding.checklist.allDoneTitle")
                  : t("onboarding.checklist.title")}
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {showAllDone
                  ? t("onboarding.checklist.allDoneHint")
                  : t("onboarding.checklist.subtitle")}
              </p>
            </div>
            {!showAllDone && (
              <Badge
                variant="outline"
                data-onboarding-counter
                className="shrink-0 whitespace-nowrap"
              >
                <CircleCheckBig className="h-3 w-3" aria-hidden="true" />
                {t("onboarding.checklist.counter", {
                  resolved: resolvedCount,
                  total: STEP_ORDER.length,
                })}
              </Badge>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={handleDismiss}
              aria-label={t("onboarding.checklist.dismissAria")}
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {showAllDone ? (
            <Link
              to={`/${slug}/boards/${firstBoard?.slug ?? firstBoardId}`}
              className={buttonVariants()}
            >
              {t("onboarding.checklist.allDoneAction")}
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          ) : (
            <OnboardingRail
              steps={STEP_ORDER.map(({ id, icon, labelKey }) => ({
                id,
                icon,
                label: t(labelKey),
                state: stepState(id),
              }))}
              progress={(resolvedCount / STEP_ORDER.length) * 100}
              activeStepId={activeStepId}
              onOpen={openStep}
            />
          )}

          <div
            data-onboarding-footer
            className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground"
          >
            <span className="font-medium text-foreground">
              {t("onboarding.checklist.footerRunners")}
            </span>
            <Badge variant="outline">{t("onboarding.experimentalBadge")}</Badge>
            <span>{t("onboarding.checklist.footerText")}</span>
            <Link
              to={`/${slug}/documentation/registering-a-runner`}
              aria-label={t("onboarding.checklist.footerLinkLabel")}
              className="inline-flex items-center transition-colors hover:text-foreground"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>

    {selectedStep && (
      <StepDialog
        id={selectedStep.id}
        icon={selectedStep.icon}
        title={t(selectedStep.titleKey)}
        intro={t(selectedStep.introKey)}
        bullets={selectedStep.bulletKeys.map((key) => t(key))}
        optionalLabel={
          selectedStep.optional
            ? t("onboarding.checklist.stepReposOptional")
            : undefined
        }
        state={stepState(selectedStep.id)}
        open={dialogOpen}
        onClose={closeStep}
        skipLabel={
          selectedStep.id === "members"
            ? t("onboarding.checklist.stepMembersSoloSkip")
            : t("onboarding.checklist.skip")
        }
        onSkip={() => {
          skipStep(selectedStep.id);
          closeStep();
        }}
        onRevisit={() => revisitStep(selectedStep.id)}
      >
        {selectedStep.id === "board" ? (
          sessionBoard ? (
            <BoardCardInputs slug={slug} board={sessionBoard} />
          ) : (
            <BoardMiniForm slug={slug} onCreated={setSessionBoard} />
          )
        ) : selectedStep.id === "context" ? (
          firstBoardId ? (
            <ContextMiniForm slug={slug} boardId={firstBoardId} />
          ) : (
            <NeedsBoardHint messageKey="onboarding.checklist.stepContextNeedsBoard" />
          )
        ) : selectedStep.id === "notes" ? (
          <NoteMiniForm slug={slug} />
        ) : selectedStep.id === "members" ? (
          <MembersMiniForm slug={slug} />
        ) : selectedStep.id === "channels" ? (
          <ChannelMiniForm slug={slug} />
        ) : firstBoardId ? (
          <RepoMiniForm slug={slug} boardId={firstBoardId} />
        ) : (
          <NeedsBoardHint messageKey="onboarding.checklist.stepReposNeedsBoard" />
        )}
      </StepDialog>
    )}
    </>
  );
}

interface StepDialogProps {
  id: StepId;
  icon: LucideIcon;
  title: string;
  intro: string;
  bullets: string[];
  optionalLabel?: string;
  state: StepState;
  open: boolean;
  onClose: () => void;
  skipLabel: string;
  onSkip: () => void;
  onRevisit: () => void;
  children: React.ReactNode;
}

// Teach, then ask: the modal explains why the step matters and draws what it
// produces before offering the mini-form. Skip/revisit live here now that the
// rail's pills carry no controls of their own. The shared DialogContent omits
// role="dialog" (see WelcomeModal) — set it here.
function StepDialog({
  id,
  icon: Icon,
  title,
  intro,
  bullets,
  optionalLabel,
  state,
  open,
  onClose,
  skipLabel,
  onSkip,
  onRevisit,
  children,
}: StepDialogProps) {
  const { t } = useTranslation();
  const done = state === "done";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        role="dialog"
        aria-modal="true"
        data-onboarding-modal=""
        // Deliberately NOT data-onboarding-step/data-step-state: the rail's
        // pill is the single element carrying a step's identity and state, so
        // those selectors never match two nodes at once.
        data-onboarding-modal-step={id}
        className="max-w-lg"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              data-step-icon
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary"
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              {optionalLabel && (
                <span className="mt-0.5 block text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {optionalLabel}
                </span>
              )}
            </div>
            {/* The status marker moved off the pill's cramped row into the
                modal header, where "Done" can be a word and not just a glyph. */}
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 text-xs font-medium",
                done && "text-[color:var(--color-success)]",
              )}
            >
              <StepStatusIcon state={state} />
              {done
                ? t("onboarding.checklist.done")
                : state === "skipped"
                  ? t("onboarding.checklist.skipped")
                  : null}
            </span>
          </div>
        </DialogHeader>

        <p
          data-step-intro
          className="text-sm leading-relaxed text-muted-foreground"
        >
          {intro}
        </p>

        <ul className="flex flex-col gap-2">
          {bullets.map((bullet) => (
            <li
              key={bullet}
              data-step-bullet
              className="flex items-start gap-2 text-sm leading-relaxed text-foreground"
            >
              <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>

        <OnboardingStepIllustration id={id} />

        <div className="border-t border-border/60 pt-4">
          <p
            data-step-form-heading
            className="text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground"
          >
            {t("onboarding.checklist.stepModalFormHeading")}
          </p>
          <div className="mt-3">{children}</div>
        </div>

        {/* A done step needs neither control: it offers no way back to
            "pending", exactly as the grid's card behaved. */}
        {!done && (
          <div className="flex justify-end border-t border-border/60 pt-3">
            <button
              type="button"
              onClick={state === "skipped" ? onRevisit : onSkip}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {state === "skipped"
                ? t("onboarding.checklist.revisit")
                : skipLabel}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepStatusIcon({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <CheckCircle2
        data-step-status-icon
        className="h-5 w-5 shrink-0 text-[color:var(--color-success)]"
        aria-hidden
      />
    );
  if (state === "skipped")
    return (
      <Minus
        data-step-status-icon
        className="h-4 w-4 shrink-0 text-muted-foreground/70"
        aria-hidden
      />
    );
  return (
    <CircleDashed
      data-step-status-icon
      className="h-4 w-4 shrink-0 text-muted-foreground/70"
      aria-hidden
    />
  );
}

function BoardMiniForm({
  slug,
  onCreated,
}: {
  slug: string;
  onCreated: (board: BoardDetail) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const createBoard = useCreateBoard(slug);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || createBoard.isPending) return;
    try {
      // The backend auto-seeds the typed To Do/In Progress/Blocked/Done
      // columns and returns them inline — never create columns client-side.
      const board = await createBoard.mutateAsync({
        name: name.trim(),
        description: "",
      });
      // The step swaps to BoardCardInputs on success, so the transition is
      // this form's feedback — but clear the field so a remount never shows
      // the consumed name.
      setName("");
      onCreated(board);
    } catch {
      // Mutation error state is on the hook — rendered below, form stays open.
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            createBoard.reset();
          }}
          placeholder={t("onboarding.checklist.stepBoardNamePlaceholder")}
          className="sm:max-w-xs"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || createBoard.isPending}
        >
          {t("onboarding.checklist.stepBoardCreateAction")}
        </Button>
      </div>
      {createBoard.isError && (
        <MiniFormError message={t("onboarding.checklist.stepBoardError")} />
      )}
    </form>
  );
}

const CARD_INPUT_SLOTS = 3;

function BoardCardInputs({
  slug,
  board,
}: {
  slug: string;
  board: BoardDetail;
}) {
  const { t } = useTranslation();
  const [titles, setTitles] = useState<string[]>(
    Array.from({ length: CARD_INPUT_SLOTS }, () => ""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [failedCount, setFailedCount] = useState(0);
  const [createdCount, setCreatedCount] = useState(0);
  const createCard = useCreateCard(slug, board.id);
  const todoColumn = board.columns?.find(
    (column) => column.column_type === "backlog",
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!todoColumn) return;
    const filledTitles = titles.map((title) => title.trim()).filter(Boolean);
    if (filledTitles.length === 0) return;

    setSubmitting(true);
    setFailedCount(0);
    // Await every create before deciding whether to collapse the row — the
    // caller must never believe cards exist that a failed request dropped.
    const results = await Promise.allSettled(
      filledTitles.map((title, index) =>
        createCard.mutateAsync({
          title,
          column_id: todoColumn.id,
          card_type: "task",
          priority: "medium",
          // First card 1024, then +1024 each — the board's fractional-index
          // convention for appends.
          position: 1024 * (index + 1),
        }),
      ),
    );
    setSubmitting(false);

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      setFailedCount(failed);
      return;
    }
    // Confirm in place rather than closing the modal out from under the user:
    // the slots reset so more cards can be added in the same sitting.
    setCreatedCount(results.length);
    setTitles(Array.from({ length: CARD_INPUT_SLOTS }, () => ""));
  }

  const hasAnyTitle = titles.some((title) => title.trim());

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <p className="text-xs font-medium text-foreground">
        {t("onboarding.checklist.stepBoardCardsPrompt")}
      </p>
      {titles.map((title, index) => (
        <Input
          key={index}
          value={title}
          onChange={(event) => {
            setTitles((current) =>
              current.map((existing, i) =>
                i === index ? event.target.value : existing,
              ),
            );
            setCreatedCount(0);
            setFailedCount(0);
          }}
          placeholder={t("onboarding.checklist.stepBoardCardPlaceholder")}
          className="sm:max-w-sm"
        />
      ))}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={!hasAnyTitle || submitting}
      >
        {t("onboarding.checklist.stepBoardCardsAction")}
      </Button>
      {failedCount > 0 && (
        <MiniFormError
          message={t("onboarding.checklist.stepBoardCardsError", {
            count: failedCount,
          })}
        />
      )}
      {createdCount > 0 && (
        <MiniFormSuccess
          message={t("onboarding.checklist.stepBoardCardsSuccess", {
            count: createdCount,
          })}
        />
      )}
    </form>
  );
}

function NeedsBoardHint({ messageKey }: { messageKey: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {t(messageKey)}
    </p>
  );
}

// Shared inline error idiom for the wizard's mini-forms — matches
// LoginPage/SetupPage/ChangePasswordDialog's destructive-tinted alert exactly.
function MiniFormError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

// The success mirror of MiniFormError. role="status" (not "alert") so screen
// readers announce it politely; --color-success is the standalone-glyph green
// that holds in both themes, never the on-tinted-bg pairing token.
function MiniFormSuccess({ message }: { message: string }) {
  return (
    <p
      role="status"
      data-mini-form-success
      className="flex items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--color-success)_40%,transparent)] bg-[color:color-mix(in_oklab,var(--color-success)_10%,transparent)] px-3 py-2 text-sm text-[color:var(--color-success)]"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function ContextMiniForm({ slug, boardId }: { slug: string; boardId: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const upsertDefinition = useUpsertDefinition(slug, boardId);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || upsertDefinition.isPending) return;
    // The definition is structured — a free-text intro maps most honestly to
    // a single unprioritized objective, which search and agents both read.
    upsertDefinition.mutate({
      content: { objectives: [{ text: text.trim(), priority: null }] },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {/* Unlike the create-forms, this one KEEPS its text on success: the
          definition is an upsert, so what's in the box is the saved value,
          not a consumed input. */}
      <Textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          upsertDefinition.reset();
        }}
        placeholder={t("onboarding.checklist.stepContextPlaceholder")}
        className="sm:max-w-md"
      />
      <Button
        type="submit"
        size="sm"
        disabled={!text.trim() || upsertDefinition.isPending}
      >
        {t("onboarding.checklist.stepContextSaveAction")}
      </Button>
      {upsertDefinition.isError && (
        <MiniFormError message={t("onboarding.checklist.stepContextError")} />
      )}
      {upsertDefinition.isSuccess && (
        <MiniFormSuccess message={t("onboarding.checklist.stepContextSuccess")} />
      )}
    </form>
  );
}

function NoteMiniForm({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // No boardId: the wizard's note is workspace-level.
  const createNote = useCreateNote(slug);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || createNote.isPending) return;
    createNote.mutate(
      { title: title.trim(), content: body },
      {
        // note_count lives on the dashboard summary — refetch it so the row
        // flips without a page refresh.
        onSuccess: () => {
          setTitle("");
          setBody("");
          queryClient.invalidateQueries({
            queryKey: dashboardKeys.summary(slug),
          });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          createNote.reset();
        }}
        placeholder={t("onboarding.checklist.stepNotesTitlePlaceholder")}
        className="sm:max-w-md"
      />
      <Textarea
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          createNote.reset();
        }}
        placeholder={t("onboarding.checklist.stepNotesBodyPlaceholder")}
        className="sm:max-w-md"
      />
      <Button
        type="submit"
        size="sm"
        disabled={!title.trim() || createNote.isPending}
      >
        {t("onboarding.checklist.stepNotesCreateAction")}
      </Button>
      {createNote.isError && (
        <MiniFormError message={t("onboarding.checklist.stepNotesError")} />
      )}
      {createNote.isSuccess && (
        <MiniFormSuccess message={t("onboarding.checklist.stepNotesSuccess")} />
      )}
    </form>
  );
}

// The wizard never hands out owner — ownership stays a deliberate act in
// workspace settings.
const INVITABLE_ROLES: WorkspaceRole[] = ["member", "admin", "viewer"];

interface MemberRowDraft {
  email: string;
  role: WorkspaceRole;
}

function MembersMiniForm({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemberRowDraft[]>([
    { email: "", role: "member" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [invitedCount, setInvitedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const addMember = useAddMember(slug);

  function updateRow(index: number, patch: Partial<MemberRowDraft>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setInvitedCount(0);
    setFailedCount(0);
  }

  // One mutation per filled row, all awaited before reporting — the caller
  // must never see "invited" for a row whose request failed. Same
  // Promise.allSettled contract as BoardCardInputs.
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const filled = rows.filter((row) => row.email.trim());
    if (filled.length === 0 || submitting) return;

    setSubmitting(true);
    setInvitedCount(0);
    setFailedCount(0);
    const results = await Promise.allSettled(
      filled.map((row) =>
        addMember.mutateAsync({ email: row.email.trim(), role: row.role }),
      ),
    );
    setSubmitting(false);

    const failed = results.filter((r) => r.status === "rejected").length;
    setFailedCount(failed);
    setInvitedCount(results.length - failed);
    // Only the rows that landed clear; a failed address stays editable.
    if (failed === 0) setRows([{ email: "", role: "member" }]);
  }

  const hasAnyEmail = rows.some((row) => row.email.trim());

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            value={row.email}
            onChange={(event) => updateRow(index, { email: event.target.value })}
            placeholder={t("onboarding.checklist.stepMembersEmailPlaceholder")}
            className="sm:max-w-xs"
          />
          {/* Native select: correct combobox semantics without the overlay
              machinery of the shadcn Select — right-sized for an inline row. */}
          <select
            value={row.role}
            onChange={(event) =>
              updateRow(index, { role: event.target.value as WorkspaceRole })
            }
            aria-label={t("onboarding.checklist.stepMembersRoleLabel")}
            className="h-9 rounded-[var(--radius-cap)] border border-input/85 bg-[color:var(--color-surface-1)] px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          >
            {INVITABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`members.roles.${role}`)}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!hasAnyEmail || submitting}>
          {t("onboarding.checklist.stepMembersAddAction")}
        </Button>
        <button
          type="button"
          onClick={() =>
            setRows((current) => [...current, { email: "", role: "member" }])
          }
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("onboarding.checklist.stepMembersAddRow")}
        </button>
      </div>
      {failedCount > 0 && (
        <MiniFormError
          message={t("onboarding.checklist.stepMembersFailedError", {
            count: failedCount,
          })}
        />
      )}
      {invitedCount > 0 && (
        <MiniFormSuccess
          message={t("onboarding.checklist.stepMembersSuccess", {
            count: invitedCount,
          })}
        />
      )}
    </form>
  );
}

function ChannelMiniForm({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Suggested default, not sample data — submitted untouched it becomes the
  // workspace's first real channel.
  const [name, setName] = useState("general");
  const createChannel = useCreateChannel(slug);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || createChannel.isPending) return;
    // The wizard only asks for a name; channel_type/contact_value are
    // required by the API, so it picks the quietest valid defaults.
    createChannel.mutate(
      { name: name.trim(), channel_type: "other", contact_value: "" },
      {
        // channel_count is summary-derived — same refetch obligation as notes.
        onSuccess: () => {
          setName("");
          queryClient.invalidateQueries({
            queryKey: dashboardKeys.summary(slug),
          });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            createChannel.reset();
          }}
          placeholder={t("onboarding.checklist.stepChannelsNamePlaceholder")}
          className="sm:max-w-xs"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || createChannel.isPending}
        >
          {t("onboarding.checklist.stepChannelsCreateAction")}
        </Button>
      </div>
      {createChannel.isError && (
        <MiniFormError message={t("onboarding.checklist.stepChannelsError")} />
      )}
      {createChannel.isSuccess && (
        <MiniFormSuccess message={t("onboarding.checklist.stepChannelsSuccess")} />
      )}
    </form>
  );
}

function inferGitProvider(url: string): GitProvider {
  if (url.includes("github")) return "github";
  if (url.includes("gitlab")) return "gitlab";
  if (url.includes("bitbucket")) return "bitbucket";
  return "other";
}

function RepoMiniForm({ slug, boardId }: { slug: string; boardId: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const createGitRepo = useCreateGitRepo(slug, boardId);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || !name.trim() || createGitRepo.isPending) return;
    createGitRepo.mutate(
      {
        name: name.trim(),
        url: url.trim(),
        provider: inferGitProvider(url),
      },
      {
        onSuccess: () => {
          setUrl("");
          setName("");
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          createGitRepo.reset();
        }}
        placeholder={t("onboarding.checklist.stepReposUrlPlaceholder")}
        className="sm:max-w-md"
      />
      <Input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          createGitRepo.reset();
        }}
        placeholder={t("onboarding.checklist.stepReposNamePlaceholder")}
        className="sm:max-w-xs"
      />
      <Button
        type="submit"
        size="sm"
        disabled={!url.trim() || !name.trim() || createGitRepo.isPending}
      >
        {t("onboarding.checklist.stepReposCreateAction")}
      </Button>
      {createGitRepo.isError && (
        <MiniFormError message={t("onboarding.checklist.stepReposError")} />
      )}
      {createGitRepo.isSuccess && (
        <MiniFormSuccess message={t("onboarding.checklist.stepReposSuccess")} />
      )}
    </form>
  );
}
