// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  StopCircle,
  User as UserIcon,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberField } from "@/components/shared/NumberField";
import { TemplateVarPalette } from "@/components/shared/TemplateVarPalette";
import { insertAtCaret } from "@/lib/prompt-caret";
import { ToolPicker } from "@/features/agents/components/pipeline-builder/ToolPicker";
import { type ExecutionSummary } from "@/features/agents/api/agents";
import { useWorkspaceConfig } from "@/features/agents/hooks/useWorkspaceConfig";
import { useGitRepos } from "@/features/git/api/use-git-repos";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { isApiError } from "@/lib/api-error";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
} from "@/lib/format";
import {
  BOARD_LOOP_DEFAULTS,
  FALLBACK_RUNNER_VARS,
  hasSlots,
  useBoardLoop,
  useLoopTemplates,
  useSaveBoardLoop,
  useSetBoardLoopState,
  type BoardLoopSaveInput,
  type BoardLoopConfig,
  type LoopTemplate,
} from "../api/use-board-loop";
import { useLoopIterations } from "../api/use-loop-iterations";
import {
  useLoopTransitions,
  type LoopTransition,
} from "../api/use-loop-transitions";
import { LoopIterationLog } from "./LoopIterationLog";
import { resolveDoneGate } from "../utils/done-gate";
import {
  formatFinding,
  parseFindings,
  type ValidationFinding,
} from "../utils/loop-findings";
import { LoopDoneGateRelaxOffer } from "./LoopDoneGateRelaxOffer";
import {
  resolveBoardLoopDisabledDiagnostic,
  resolveBoardLoopDisabledReason,
} from "../utils/resolve-board-loop-disabled-reason";
import type { Board } from "@/types/kanban";

// Tier vocabulary mirrors the runner's llm.tier_providers aliases. Anything
// else is a concrete model id — surfaced via the custom escape hatch below and
// ALWAYS round-tripped verbatim, never resolved client-side.
const MODEL_TIERS = ["premium", "mid", "low"] as const;
// Sentinel for the free-entry choice — the shadcn `<Select>` can't render an
// empty `<SelectItem value="">` (LlmEditor's UNSET idiom).
const CUSTOM_MODEL = "__custom__";

const RECENT_ITERATIONS_LIMIT = 10;

type PromptField = "system" | "loop";

import { LandingPolicyEditor } from "./LandingPolicyEditor";
import { useCompletionPolicyDraft } from "../api/use-completion";

interface Props {
  board: Board;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Entry point into the template chooser, injected by BoardLoopPanel. Absent
   * when the dialog is mounted on its own, which keeps this the wrapper's
   * concern rather than a second template flow living in here.
   */
  onApplyTemplate?: () => void;
  /**
   * Entry point into "Save as template…", injected by BoardLoopPanel for the
   * same reason as `onApplyTemplate`: the flow belongs to the wrapper, so this
   * dialog gains a prop rather than a second template surface. Admin-gated by
   * the caller AND here — the action mutates workspace-level templates.
   */
  onSaveAsTemplate?: () => void;
}

export function BoardLoopDialog({
  board,
  open,
  onOpenChange,
  onApplyTemplate,
  onSaveAsTemplate,
}: Props) {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const rootId = useId();
  const fid = (name: string) => `${rootId}-${name}`;
  const { isAdmin } = useWorkspaceAdmin(slug);
  const { data: workspaceConfig } = useWorkspaceConfig(slug);
  // The done merge gate is board-aware server-side: a board with no linked
  // repo is exempt, so the hint would be a lie there. Only state the
  // requirement when it actually applies to THIS board.
  const { data: boardRepos } = useGitRepos(slug, board.id, { enabled: open });
  const doneGateArmed =
    resolveDoneGate(
      board.enforce_done_merge_gate,
      workspaceConfig?.enforce_done_merge_gate,
    ) && (boardRepos?.length ?? 0) > 0;

  // `board` is a required prop (always loaded here) — use its canonical id
  // for every loop request. The :boardId route param also accepts the
  // board's slug, but /loop and /loop/state resolve UUIDs only.
  //
  // Raw flag, unlike BoardLayout's loading→false mapping: an absent flag
  // (old backend) must fall through to fetching.
  const loopQuery = useBoardLoop(slug, board.id, board.loop_configured);
  const saveLoop = useSaveBoardLoop(slug, board.id);
  const setLoopState = useSetBoardLoopState(slug, board.id);

  // Server-scoped to this board's loop_iteration executions (board_id + action
  // query params — see backend/tests/test_workspace_executions_filters.py).
  // Arrives newest-first already; no client-side action/board filter needed
  // anymore.
  const executionsQuery = useLoopIterations(slug, board.id, board.id, open);

  // The durable stop timeline (card 6f3ca6e5) — `disabled_reason` on the
  // config carries only the latest stop and a re-enable erases it.
  const transitionsQuery = useLoopTransitions(slug, board.id, board.id, open);

  // The full paged/filterable log (card 6c036f0b) is opt-in — see the panel's
  // mount site below.
  const [showFullLog, setShowFullLog] = useState(false);

  const [provider, setProvider] = useState<string>(
    BOARD_LOOP_DEFAULTS.provider,
  );
  const [model, setModel] = useState<string>(BOARD_LOOP_DEFAULTS.model);
  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [loopPrompt, setLoopPrompt] = useState<string>("");
  const [tools, setTools] = useState<string[]>([]);
  const [maxIterations, setMaxIterations] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.max_iterations),
  );
  const [delaySeconds, setDelaySeconds] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.iteration_delay_seconds),
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.iteration_timeout_seconds),
  );
  const [budgetUsd, setBudgetUsd] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.budget_usd),
  );
  const [maxFailures, setMaxFailures] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.max_consecutive_failures),
  );
  const [maxBlockedOnHuman, setMaxBlockedOnHuman] = useState<string>(
    String(BOARD_LOOP_DEFAULTS.max_blocked_on_human),
  );
  const [starvationPolicy, setStarvationPolicy] = useState<string>(
    BOARD_LOOP_DEFAULTS.starvation_policy,
  );
  const [loopLanding, setLoopLanding] = useState<string>(
    BOARD_LOOP_DEFAULTS.loop_landing,
  );
  const [mergeGate, setMergeGate] = useState<string>(
    BOARD_LOOP_DEFAULTS.merge_gate,
  );
  const [skillsProposalEnabled, setSkillsProposalEnabled] = useState<boolean>(
    BOARD_LOOP_DEFAULTS.skills_proposal_enabled,
  );
  // The auto-relax is the server default on a human self_merge save; the
  // decline is the one-shot session state. It is only ever true because the
  // operator clicked "keep the gate on" in THIS editing session, and it rides
  // out on the next save as relax_done_merge_gate: false.
  const [relaxGateDeclined, setRelaxGateDeclined] = useState(false);
  // The pairing the server stamps for: this landing has the agent move its
  // own card, and the done gate requires a merged PR before that move. Read
  // from the LIVE select, not the saved config — the notice exists to land at
  // the moment of the choice.
  const gateConflictsWithLanding = loopLanding === "self_merge";
  // Only the label is editable: exclude_column_type is pinned to "done", the
  // one condition the backend accepts. "" = no completion condition.
  const [completionLabel, setCompletionLabel] = useState<string>("");
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  // "" = no template chosen. Selection fills FORM STATE only — persistence
  // stays behind the Save button.
  const [templateId, setTemplateId] = useState<string>("");
  // Non-null while the overwrite confirm gate is open (a prompt field already
  // holds text the template would clobber).
  const [pendingTemplate, setPendingTemplate] = useState<LoopTemplate | null>(
    null,
  );

  const proposedLoopConfig = {
    provider,
    model,
    system_prompt: systemPrompt,
    loop_prompt: loopPrompt,
    tools,
    starvation_policy: starvationPolicy,
    loop_landing: loopLanding,
    merge_gate: mergeGate,
    skills_proposal_enabled: skillsProposalEnabled,
    max_iterations: Number(maxIterations),
    iteration_delay_seconds: Number(delaySeconds),
    iteration_timeout_seconds: Number(timeoutSeconds),
    budget_usd: Number(budgetUsd),
    max_consecutive_failures: Number(maxFailures),
    max_blocked_on_human: Number(maxBlockedOnHuman),
    completion_query: completionLabel.trim()
      ? { label: completionLabel.trim(), exclude_column_type: "done" }
      : {},
  };
  const policy = useCompletionPolicyDraft(slug, board.id, open, proposedLoopConfig);

  // null = unconfigured (GET 404) — a valid state, edited from defaults.
  const config = loopQuery.data;
  const [formBaseline, setFormBaseline] = useState<BoardLoopConfig | null>(null);
  const [hydratedBoard, setHydratedBoard] = useState<string | null>(null);
  const [rebaseRequested, setRebaseRequested] = useState(false);
  // Mirror of the server's restore rule: a save that moves a stored
  // self_merge landing elsewhere returns the board's False override to
  // inherit, re-arming the gate. Announced, not silent.
  const rearmOnSave =
    config?.loop_landing === "self_merge" &&
    loopLanding !== "self_merge" &&
    board.enforce_done_merge_gate === false;


  const templatesQuery = useLoopTemplates(slug, open);
  const templates = templatesQuery.data?.templates ?? [];
  // The server's vocabulary wins; the fallback only covers the render before
  // the catalog resolves (and the offline case).
  const runnerVars =
    templatesQuery.data?.meta.runner_vars ?? FALLBACK_RUNNER_VARS;

  function applyTemplate(template: LoopTemplate) {
    setSystemPrompt(template.system_prompt);
    setLoopPrompt(template.loop_prompt);
    setTools([...template.tools]);
    setTemplateId(template.id);
  }

  function handleTemplateSelect(id: string) {
    const template = templates.find((entry) => entry.id === id);
    if (!template) return;
    // A slotted template can only be filled by the bind step; copying its
    // <<SLOT>>s into the textareas would 422 at save. The option renders
    // disabled, but a disabled item still carries a value — refuse here too so
    // no path reaches applyTemplate with slots. The prompts are re-checked
    // rather than the flag trusted, so a backend that omits has_slots cannot
    // smuggle an unappliable template through the enabled option it produces.
    if (hasSlots(template)) return;
    if (systemPrompt.trim() !== "" || loopPrompt.trim() !== "") {
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  }

  const systemPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const loopPromptRef = useRef<HTMLTextAreaElement | null>(null);
  // Insert-at-caret only makes sense once the operator has placed a caret —
  // before the first focus a chip click appends instead (selectionStart is 0
  // on an untouched textarea, and inserting at the very start would be wrong).
  const promptTouchedRef = useRef<Record<PromptField, boolean>>({
    system: false,
    loop: false,
  });

  function insertTemplateVar(field: PromptField, name: string) {
    const el =
      field === "system" ? systemPromptRef.current : loopPromptRef.current;
    const value = field === "system" ? systemPrompt : loopPrompt;
    const setValue = field === "system" ? setSystemPrompt : setLoopPrompt;
    const { next, caret } = insertAtCaret(
      el,
      value,
      `{{.${name}}}`,
      promptTouchedRef.current[field],
    );
    setValue(next);
    if (el) {
      // After React commits the new value, put the caret right behind the
      // inserted token so the operator can keep typing.
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      }, 0);
    }
  }

  const enabled = config?.enabled ?? false;
  const disabledReason = config
    ? resolveBoardLoopDisabledReason(config, t)
    : null;
  const disabledDiagnostic = config
    ? resolveBoardLoopDisabledDiagnostic(config, disabledReason)
    : null;
  const showDisabledExplanation =
    !enabled && Boolean(disabledReason || disabledDiagnostic);
  // Enabling an empty saved loop_prompt would 422 server-side — disable with a
  // hint instead. Turning OFF is always allowed once configured.
  const canToggle =
    !!config &&
    !setLoopState.isPending &&
    (enabled || (config.loop_prompt.trim() !== "" && !policy.dirty && (!(policy.explicit || config.completion_policy) || policy.compatible)));
  const needsPromptToEnable =
    !!config && !enabled && config.loop_prompt.trim() === "";

  const isTierModel = (MODEL_TIERS as readonly string[]).includes(model);
  const modelSelectValue = isTierModel ? model : CUSTOM_MODEL;

  // The server now does the board_id + action=loop_iteration scoping (see
  // useLoopIterations), so this filter is normally a no-op. Kept as a
  // defensive belt-and-suspenders layer — a test double or an older backend
  // that ignores the new query params must not leak other boards'/actions'
  // rows into this dialog.
  const scopedIterations = (executionsQuery.data ?? []).filter(
    (exec) => exec.action === "loop_iteration" && exec.board_id === board.id,
  );
  const loopIterations = scopedIterations.slice(0, RECENT_ITERATIONS_LIMIT);

  // Telemetry below reads from the FULL scoped window, not the
  // RECENT_ITERATIONS_LIMIT-sliced display list — spend/failure-streak math
  // should reflect everything the server returned, not just what's shown.
  const allIterations = scopedIterations;
  const newestIteration = allIterations[0];

  // Spend vs budget: cost_usd is null on every row today (the runner reports
  // cost only inside output_summary text — see makeExecution's fixture
  // comment), so this sum is currently always 0. Kept as a real sum (not
  // hardcoded 0) so it lights up the moment cost_usd starts being populated,
  // with no further UI change needed.
  const spentUsd = allIterations.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);

  // The newest iteration's input_summary is the runner's own
  // "loop iteration %d" format (loop_prompt template's {{.Iteration}}
  // substitution) — parse the trailing integer for the live count. Falls back
  // to the fetched-row count when the format doesn't match (e.g. legacy rows).
  const parsedIterationNumber = newestIteration
    ? /loop iteration (\d+)/i.exec(newestIteration.input_summary)?.[1]
    : undefined;
  const iterationCount = parsedIterationNumber
    ? Number(parsedIterationNumber)
    : allIterations.length;

  // Rail proximity: trailing consecutive-failure streak counted from the
  // newest row backward, stopping at the first non-failure.
  let consecutiveFailures = 0;
  for (const exec of allIterations) {
    if (exec.status !== "failed") break;
    consecutiveFailures += 1;
  }
  const maxFailuresConfigured = config?.max_consecutive_failures ?? null;
  const nearFailureRail =
    maxFailuresConfigured != null &&
    consecutiveFailures >= maxFailuresConfigured - 1;

  function handleToggle(next: boolean) {
    if (next && !canToggle) return;
    setLoopState.mutate(
      { enabled: next, reason: "" },
      {
        onError: () => toast.error(t("boardLoop.toggleError")),
      },
    );
  }

  // Mirrors the hydration effect field for field — same source, same `??`
  // fallbacks — so a freshly-hydrated dialog reads clean. `findings`,
  // `templateId` and `pendingTemplate` are UI state, not user content.
  const isDirty = useMemo(() => {
    const source = formBaseline ?? BOARD_LOOP_DEFAULTS;
    // The allowlist is a SET of tool names; the picker's insertion order is
    // not user content.
    const sameTools =
      tools.length === source.tools.length &&
      [...tools]
        .sort()
        .every((tool, i) => tool === [...source.tools].sort()[i]);
    return (
      provider !== source.provider ||
      model !== source.model ||
      systemPrompt !== source.system_prompt ||
      loopPrompt !== source.loop_prompt ||
      !sameTools ||
      maxIterations !== String(source.max_iterations) ||
      delaySeconds !== String(source.iteration_delay_seconds) ||
      timeoutSeconds !== String(source.iteration_timeout_seconds) ||
      budgetUsd !== String(source.budget_usd) ||
      maxFailures !== String(source.max_consecutive_failures) ||
      maxBlockedOnHuman !==
        String(
          source.max_blocked_on_human ??
            BOARD_LOOP_DEFAULTS.max_blocked_on_human,
        ) ||
      starvationPolicy !==
        (source.starvation_policy ?? BOARD_LOOP_DEFAULTS.starvation_policy) ||
      loopLanding !==
        (source.loop_landing ?? BOARD_LOOP_DEFAULTS.loop_landing) ||
      mergeGate !== (source.merge_gate ?? BOARD_LOOP_DEFAULTS.merge_gate) ||
      skillsProposalEnabled !==
        (source.skills_proposal_enabled ??
          BOARD_LOOP_DEFAULTS.skills_proposal_enabled) ||
      completionLabel !== (source.completion_query?.label ?? "")
    );
  }, [
    formBaseline,
    provider,
    model,
    systemPrompt,
    loopPrompt,
    tools,
    maxIterations,
    delaySeconds,
    timeoutSeconds,
    budgetUsd,
    maxFailures,
    maxBlockedOnHuman,
    starvationPolicy,
    loopLanding,
    mergeGate,
    skillsProposalEnabled,
    completionLabel,
  ]);

  useEffect(() => {
    if (!open) { setHydratedBoard(null); return; }
    if (config === undefined) return;
    const hydrated = hydratedBoard === board.id;
    if (hydrated && !rebaseRequested && (formBaseline === config || isDirty || policy.dirty)) return;
    const source = config ?? BOARD_LOOP_DEFAULTS;
    const previous = formBaseline ?? BOARD_LOOP_DEFAULTS;
    const keepEdits = hydrated && rebaseRequested;
    const adopt = <T,>(current: T, before: T, next: T): T => keepEdits && current !== before ? current : next;
    setProvider((value) => adopt(value, previous.provider, source.provider));
    setModel((value) => adopt(value, previous.model, source.model));
    setSystemPrompt((value) => adopt(value, previous.system_prompt, source.system_prompt));
    setLoopPrompt((value) => adopt(value, previous.loop_prompt, source.loop_prompt));
    setTools((value) => keepEdits && JSON.stringify([...value].sort()) !== JSON.stringify([...previous.tools].sort()) ? value : [...source.tools]);
    setMaxIterations((value) => adopt(value, String(previous.max_iterations), String(source.max_iterations)));
    setDelaySeconds((value) => adopt(value, String(previous.iteration_delay_seconds), String(source.iteration_delay_seconds)));
    setTimeoutSeconds((value) => adopt(value, String(previous.iteration_timeout_seconds), String(source.iteration_timeout_seconds)));
    setBudgetUsd((value) => adopt(value, String(previous.budget_usd), String(source.budget_usd)));
    setMaxFailures((value) => adopt(value, String(previous.max_consecutive_failures), String(source.max_consecutive_failures)));
    // ?? — a cached config fetched from a backend predating these fields.
    setMaxBlockedOnHuman((value) => adopt(value, String(previous.max_blocked_on_human ?? BOARD_LOOP_DEFAULTS.max_blocked_on_human), String(source.max_blocked_on_human ?? BOARD_LOOP_DEFAULTS.max_blocked_on_human)));
    setStarvationPolicy((value) => adopt(value, previous.starvation_policy ?? BOARD_LOOP_DEFAULTS.starvation_policy, source.starvation_policy ?? BOARD_LOOP_DEFAULTS.starvation_policy));
    setLoopLanding((value) => adopt(value, previous.loop_landing ?? BOARD_LOOP_DEFAULTS.loop_landing, source.loop_landing ?? BOARD_LOOP_DEFAULTS.loop_landing));
    setMergeGate((value) => adopt(value, previous.merge_gate ?? BOARD_LOOP_DEFAULTS.merge_gate, source.merge_gate ?? BOARD_LOOP_DEFAULTS.merge_gate));
    setSkillsProposalEnabled((value) => adopt(value, previous.skills_proposal_enabled ?? BOARD_LOOP_DEFAULTS.skills_proposal_enabled, source.skills_proposal_enabled ?? BOARD_LOOP_DEFAULTS.skills_proposal_enabled));
    setCompletionLabel((value) => adopt(value, previous.completion_query?.label ?? "", source.completion_query?.label ?? ""));
    setFindings([]);
    setTemplateId("");
    setPendingTemplate(null);
    // A decline is scoped to its editing session — DialogContent unmounts on
    // close, and a decline that outlived it would silently ride out on an
    // unrelated later save.
    if (!keepEdits) setRelaxGateDeclined(false);
    // DialogContent unmounts on close, so a reopened dialog has fresh
    // textareas reporting selectionStart 0 — a stale "touched" claim would
    // make the next var-chip click prepend instead of append.
    promptTouchedRef.current = { system: false, loop: false };
    setFormBaseline(config);
    setHydratedBoard(board.id);
    setRebaseRequested(false);
  }, [config, open, board.id, formBaseline, isDirty, policy.dirty, rebaseRequested, hydratedBoard]);


  const formReady = hydratedBoard === board.id && config !== undefined;
  const hasNewerConfig = hydratedBoard === board.id && config?.version !== formBaseline?.version;

  const guard = useUnsavedChangesGuard({
    isDirty: isDirty || policy.dirty,
    onClose: () => onOpenChange(false),
    // The EXISTING submit path, so expected_version and the conflict toast
    // still apply (PRs #130/#134).
    onSave: () => handleSave(),
    canSave: formReady && isAdmin && !saveLoop.isPending && policy.canSave,
  });

  function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (!formReady || !isAdmin || saveLoop.isPending || !policy.canSave) return;
    const caps = {
      max_iterations: Number(maxIterations),
      iteration_delay_seconds: Number(delaySeconds),
      iteration_timeout_seconds: Number(timeoutSeconds),
      budget_usd: Number(budgetUsd),
      max_consecutive_failures: Number(maxFailures),
      max_blocked_on_human: Number(maxBlockedOnHuman),
    };
    if (Object.values(caps).some((n) => Number.isNaN(n))) {
      setFindings([{ field: "", message: t("boardLoop.invalidNumbers") }]);
      return;
    }
    const body: BoardLoopSaveInput = {
      // `enabled` rides along unchanged — the toggle owns state flips via
      // PATCH /loop/state; PUT is a full config replace.
      enabled,
      provider,
      model,
      system_prompt: systemPrompt,
      loop_prompt: loopPrompt,
      tools,
      starvation_policy: starvationPolicy,
      loop_landing: policy.loopConfig?.loop_landing ?? loopLanding,
      merge_gate: policy.loopConfig?.merge_gate ?? mergeGate,
      // Explicit boolean, never omitted: the server default is true, so a
      // dropped field would flip an opted-out board back on.
      skills_proposal_enabled: skillsProposalEnabled,
      // Only the DECLINE is ever sent: an omitted field is the accepted
      // default (the server auto-relaxes on a human self_merge save).
      // Re-checking the conflict stops a decline given under self_merge from
      // riding out on a landing switched afterwards.
      ...(!policy.explicit && relaxGateDeclined && gateConflictsWithLanding
        ? { relax_done_merge_gate: false }
        : {}),
      // `{}` is the clear lever — an omitted field means "unchanged" on the
      // PUT merge, so a blanked label has no other way to turn the condition
      // off.
      completion_query: completionLabel.trim()
        ? { label: completionLabel.trim(), exclude_column_type: "done" }
        : {},
      ...caps,
      // Zero locks a draft opened before any config existed: a concurrent
      // first creation must conflict just like an update to a loaded version.
      expected_version: formBaseline?.version ?? 0,
      ...(policy.dirty ? { completion_policy: policy.value } : {}),
    };
    setFindings([]);
    saveLoop.mutate(body, {
      onSuccess: () => onOpenChange(false),
      onError: (err) => {
        if (isApiError(err) && err.isValidation()) {
          setFindings(parseFindings(err.detail));
        } else if (isApiError(err) && err.isConflict()) {
          // Refetch leaves the draft's lock intact until the operator rebases.
          toast.error(t("boardLoop.draftConflict"));
        } else {
          toast.error(t("boardLoop.saveError"));
        }
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={guard.handleOpenChange}>
      <UnsavedChangesPrompt
        open={guard.guardOpen}
        canSave={guard.canSave}
        onSave={guard.saveAndClose}
        onDiscard={guard.closeAnyway}
        onKeepEditing={guard.dismissGuard}
      />
      {/* The shared DialogContent deliberately omits role="dialog" (RichTooltip
          owns that role in some views); set it here so assistive tech — and the
          test locator contract — see a real modal dialog. */}
      {/* Width-hungry content (two prompt textareas, the tool allowlist, rails,
          recent iterations) — the first consumer of the shared resize contract.
          Defaults wider than the old 42rem cap and remembers the operator's
          drag across opens. */}
      <DialogContent
        role="dialog"
        aria-modal="true"
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
        resizable
        resizeStorageKey="board-loop"
        defaultWidth={896}
        minWidth={672}
        maxWidth={1400}
        resizeHandleLabel={t("boardLoop.resizeHandle")}
      >
        {/* Scroll ownership lives on the inner body, not the panel, so the
            footer stays a pinned flex sibling however tall the config grows —
            the same three-part contract CardDetailSheet documents. */}
        <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
          {/* Keep native fieldset layout inside the scrolling flex item so
              disabled hydration controls cannot break scrolling or clipping. */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <fieldset disabled={!formReady} className="m-0 min-w-0 space-y-5 border-0 p-0">
            <DialogHeader>
              <DialogTitle>{t("boardLoop.title")}</DialogTitle>
              <DialogDescription>{t("boardLoop.subtitle")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-3 rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40 p-3">
              <Checkbox
                id={fid("enabled")}
                checked={enabled}
                disabled={!canToggle}
                onCheckedChange={handleToggle}
                label={t("boardLoop.enableLabel")}
                description={
                  // Unconfigured boards can't be toggled at all — the state
                  // PATCH 404s until a first save creates the config.
                  !config
                    ? t("boardLoop.saveFirstHint")
                    : needsPromptToEnable
                      ? t("boardLoop.enableRequiresPrompt")
                      : t("boardLoop.enableHint")
                }
              />
              <p className="text-xs text-muted-foreground">{t("boardLoop.budgetEpochHint")}</p>
              {showDisabledExplanation ? (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    {disabledReason ? (
                      <div className="space-y-0.5">
                        <p className="font-medium">
                          {t("boardLoop.disabledReasonTitle")}
                        </p>
                        <p>{disabledReason}</p>
                      </div>
                    ) : null}
                    {disabledDiagnostic ? (
                      <div className="space-y-0.5 border-t border-current/20 pt-1">
                        <p className="font-medium">
                          {t("boardLoop.reasons.diagnosticLabel")}
                        </p>
                        <p className="whitespace-pre-wrap break-words font-mono">
                          {disabledDiagnostic}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {!policy.explicit && !config?.completion_policy && doneGateArmed &&
                (gateConflictsWithLanding ? (
                  board.enforce_done_merge_gate === true ? (
                    // An explicitly enforced board is one the server refuses
                    // to implicitly soften — the relax notice would promise a
                    // stamp that will not happen. State the conflict and
                    // where the lever lives instead.
                    <div
                      data-testid="board-loop-enforced-gate-warning"
                      role="status"
                      className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      <p>{t("boardLoop.relaxGate.enforcedConflict")}</p>
                    </div>
                  ) : (
                    <LoopDoneGateRelaxOffer
                      declined={relaxGateDeclined}
                      onDeclinedChange={setRelaxGateDeclined}
                      disabled={saveLoop.isPending}
                    />
                  )
                ) : (
                  <div
                    data-testid="board-loop-done-gate-hint"
                    role="status"
                    className="rounded-md border border-border/70 bg-surface-1/60 p-2 text-xs text-muted-foreground"
                  >
                    <p>{t("boardLoop.doneGateInfo")}</p>
                  </div>
                ))}
              {!policy.explicit && !config?.completion_policy && rearmOnSave ? (
                <div
                  data-testid="board-loop-rearm-notice"
                  role="status"
                  className="rounded-md border border-border/70 bg-surface-1/60 p-2 text-xs text-muted-foreground"
                >
                  <p>{t("boardLoop.relaxGate.rearm")}</p>
                </div>
              ) : null}
            </div>

            {isAdmin && policy.current.isSuccess && <LandingPolicyEditor slug={slug} boardId={board.id} value={policy.value} loopConfig={policy.loopConfig} onChange={policy.onChange} onApply={() => void handleSave()} hideApply disabled={saveLoop.isPending || policy.isPending} />}
            {policy.current.isError && <div role="status" className="space-y-2 text-sm text-destructive"><p>{t("completionPolicy.previewFailed")}</p><Button type="button" size="sm" variant="outline" onClick={() => void policy.current.refetch()}>{t("completionPolicy.reload")}</Button></div>}
            {policy.error && <p role="alert" className="text-sm text-destructive">{t("completionPolicy.saveFailed")}</p>}
            {policy.explicit && <p className="text-xs text-muted-foreground">{t("completionPolicy.legacyGateHint")}</p>}
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={fid("template")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.template.label")}
                  </label>
                  <div className="flex items-center gap-3">
                    {onApplyTemplate && (
                      <button
                        type="button"
                        onClick={onApplyTemplate}
                        data-testid="board-loop-apply-template"
                        className="text-muted-foreground hover:text-foreground text-xs underline"
                      >
                        {t("boardLoop.templates.applyTemplate")}
                      </button>
                    )}
                    {onSaveAsTemplate && isAdmin && (
                      <button
                        type="button"
                        onClick={onSaveAsTemplate}
                        data-testid="board-loop-save-as-template"
                        className="text-muted-foreground hover:text-foreground text-xs underline"
                      >
                        {t("loopTemplates.saveAs.action")}
                      </button>
                    )}
                  </div>
                </div>
                <Select value={templateId} onValueChange={handleTemplateSelect}>
                  <SelectTrigger
                    id={fid("template")}
                    data-testid="loop-template-select"
                  >
                    <SelectValue
                      placeholder={t("boardLoop.template.placeholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem
                        key={template.id}
                        value={template.id}
                        disabled={template.has_slots}
                      >
                        {template.name}
                        {template.has_slots === true && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t("boardLoop.template.needsBindStep")}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("boardLoop.template.hint")}
                </p>
                {pendingTemplate && (
                  <div
                    data-testid="loop-template-confirm"
                    role="status"
                    className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    <p>
                      {t("boardLoop.template.confirmBody", {
                        name: pendingTemplate.name,
                      })}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="loop-template-confirm-cancel"
                        onClick={() => setPendingTemplate(null)}
                      >
                        {t("boardLoop.template.confirmCancel")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        data-testid="loop-template-confirm-apply"
                        onClick={() => {
                          applyTemplate(pendingTemplate);
                          setPendingTemplate(null);
                        }}
                      >
                        {t("boardLoop.template.confirmApply")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label
                  htmlFor={fid("system-prompt")}
                  className="text-sm font-medium"
                >
                  {t("boardLoop.systemPromptLabel")}
                </label>
                <Textarea
                  id={fid("system-prompt")}
                  ref={systemPromptRef}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  onFocus={() => {
                    promptTouchedRef.current.system = true;
                  }}
                  placeholder={t("boardLoop.systemPromptPlaceholder", {
                    workspaceVar: "{{.Workspace}}",
                  })}
                  rows={2}
                />
                <TemplateVarChips
                  field="system"
                  vars={runnerVars}
                  onInsert={insertTemplateVar}
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor={fid("loop-prompt")}
                  className="text-sm font-medium"
                >
                  {t("boardLoop.loopPromptLabel")}
                </label>
                <Textarea
                  id={fid("loop-prompt")}
                  ref={loopPromptRef}
                  value={loopPrompt}
                  onChange={(e) => setLoopPrompt(e.target.value)}
                  onFocus={() => {
                    promptTouchedRef.current.loop = true;
                  }}
                  placeholder={t("boardLoop.loopPromptPlaceholder", {
                    iterationVar: "{{.Iteration}}",
                    boardVar: "{{.BoardID}}",
                  })}
                  rows={4}
                />
                <TemplateVarChips
                  field="loop"
                  vars={runnerVars}
                  onInsert={insertTemplateVar}
                />
                <p className="text-xs text-muted-foreground">
                  {t("boardLoop.loopPromptHint")}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <label
                    htmlFor={fid("provider")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.providerLabel")}
                  </label>
                  <Input
                    id={fid("provider")}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder={t("boardLoop.providerPlaceholder")}
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor={fid("model")} className="text-sm font-medium">
                    {t("boardLoop.modelLabel")}
                  </label>
                  <Select
                    value={modelSelectValue}
                    onValueChange={(v) =>
                      setModel(
                        v === CUSTOM_MODEL ? (isTierModel ? "" : model) : v,
                      )
                    }
                  >
                    <SelectTrigger id={fid("model")}>
                      <SelectValue>
                        {isTierModel
                          ? t(`boardLoop.modelTiers.${model}`)
                          : t("boardLoop.modelCustomOption")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_TIERS.map((tier) => (
                        <SelectItem key={tier} value={tier}>
                          {t(`boardLoop.modelTiers.${tier}`)}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_MODEL}>
                        {t("boardLoop.modelCustomOption")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {!isTierModel && (
                    <>
                      <label
                        htmlFor={fid("model-custom")}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {t("boardLoop.modelCustomLabel")}
                      </label>
                      <Input
                        id={fid("model-custom")}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={t("boardLoop.modelCustomPlaceholder")}
                        className="font-mono text-xs"
                      />
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                {/* ToolPicker doesn't take a label-bound input; the label is
                  visual-only (LlmEditor's as="span" idiom). */}
                <span className="text-sm font-medium">
                  {t("boardLoop.toolsLabel")}
                </span>
                <p className="text-xs text-muted-foreground">
                  {t("boardLoop.toolsHint")}
                </p>
                <ToolPicker
                  id={fid("tools")}
                  value={tools}
                  onChange={setTools}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  id={fid("max-iterations")}
                  label={t("boardLoop.maxIterationsLabel")}
                  value={maxIterations}
                  onChange={setMaxIterations}
                  min={1}
                />
                <NumberField
                  id={fid("delay")}
                  label={t("boardLoop.delayLabel")}
                  value={delaySeconds}
                  onChange={setDelaySeconds}
                  min={0}
                />
                <NumberField
                  id={fid("timeout")}
                  label={t("boardLoop.timeoutLabel")}
                  value={timeoutSeconds}
                  onChange={setTimeoutSeconds}
                  min={1}
                />
                <NumberField
                  id={fid("budget")}
                  label={t("boardLoop.budgetLabel")}
                  value={budgetUsd}
                  onChange={setBudgetUsd}
                  min={0.01}
                  step={0.01}
                />
                <NumberField
                  id={fid("failures")}
                  label={t("boardLoop.failuresLabel")}
                  value={maxFailures}
                  onChange={setMaxFailures}
                  min={1}
                />
                <NumberField
                  id={fid("blocked-on-human")}
                  label={t("boardLoop.blockedOnHumanLabel")}
                  value={maxBlockedOnHuman}
                  onChange={setMaxBlockedOnHuman}
                  min={0}
                />
                <div className="space-y-1.5">
                  <label
                    htmlFor={fid("completion-label")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.completionQueryLabel")}
                  </label>
                  <Input
                    id={fid("completion-label")}
                    value={completionLabel}
                    onChange={(e) => setCompletionLabel(e.target.value)}
                    placeholder={t("boardLoop.completionQueryPlaceholder")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("boardLoop.completionQueryHelp")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={fid("starvation-policy")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.starvationPolicyLabel")}
                  </label>
                  <Select
                    value={starvationPolicy}
                    onValueChange={setStarvationPolicy}
                  >
                    <SelectTrigger id={fid("starvation-policy")}>
                      <SelectValue>
                        {t(`boardLoop.starvationPolicies.${starvationPolicy}`)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="park">
                        {t("boardLoop.starvationPolicies.park")}
                      </SelectItem>
                      <SelectItem value="always_run">
                        {t("boardLoop.starvationPolicies.always_run")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("boardLoop.starvationPolicyHint")}
                  </p>
                </div>
                {!policy.explicit && !config?.completion_policy && <>
                <div className="space-y-1.5">
                  <label
                    htmlFor={fid("loop-landing")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.loopLandingLabel")}
                  </label>
                  <Select value={loopLanding} onValueChange={setLoopLanding}>
                    <SelectTrigger id={fid("loop-landing")}>
                      <SelectValue>
                        {t(`boardLoop.loopLandings.${loopLanding}`)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="self_merge">
                        {t("boardLoop.loopLandings.self_merge")}
                      </SelectItem>
                      <SelectItem value="human">
                        {t("boardLoop.loopLandings.human")}
                      </SelectItem>
                      <SelectItem value="merge_queue">
                        {t("boardLoop.loopLandings.merge_queue")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("boardLoop.loopLandingHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={fid("merge-gate")}
                    className="text-sm font-medium"
                  >
                    {t("boardLoop.mergeGateLabel")}
                  </label>
                  <Select value={mergeGate} onValueChange={setMergeGate}>
                    <SelectTrigger id={fid("merge-gate")}>
                      <SelectValue>
                        {t(`boardLoop.mergeGates.${mergeGate}`)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forge_ci">
                        {t("boardLoop.mergeGates.forge_ci")}
                      </SelectItem>
                      <SelectItem value="none">
                        {t("boardLoop.mergeGates.none")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("boardLoop.mergeGateHint")}
                  </p>
                </div>
                </>}
                <Checkbox
                  id={fid("skills-proposal")}
                  checked={skillsProposalEnabled}
                  onCheckedChange={setSkillsProposalEnabled}
                  label={t("boardLoop.skillsProposalLabel")}
                  description={t("boardLoop.skillsProposalHint")}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                <Link
                  to={`/${slug}/documentation/loop-mode`}
                  className="text-primary underline underline-offset-2"
                >
                  {t("boardLoop.docsLinkLabel")}
                </Link>{" "}
                {t("boardLoop.playbookHint")}
              </p>
            </div>

            <section className="space-y-2 border-t border-border/70 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  {t("boardLoop.iterationsTitle")}
                </h3>
                {/* type="button": this section lives inside the config <form>,
                  so a default-type button would submit the loop config. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="loop-iteration-log-open"
                  aria-expanded={showFullLog}
                  onClick={() => setShowFullLog((shown) => !shown)}
                >
                  {showFullLog
                    ? t("boardLoop.iterationLog.hide")
                    : t("boardLoop.iterationLog.viewFull")}
                </Button>
              </div>
              {config && (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    {t("boardLoop.telemetry.spend", {
                      spent: formatNumber(spentUsd, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }),
                      budget: formatNumber(config.budget_usd, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }),
                    })}
                  </p>
                  <p>
                    {t("boardLoop.telemetry.iterationCount", {
                      count: iterationCount,
                      max: config.max_iterations,
                    })}
                  </p>
                  {nearFailureRail && (
                    <div
                      data-testid="board-loop-failure-rail-warning"
                      role="status"
                      className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      <AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      />
                      <p>
                        {t("boardLoop.telemetry.nearFailureRail", {
                          count: consecutiveFailures,
                          max: config.max_consecutive_failures,
                        })}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {loopIterations.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("boardLoop.iterationsEmpty")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {loopIterations.map((exec) => (
                    <IterationRow key={exec.id} execution={exec} />
                  ))}
                </ul>
              )}
              {/* Mounted only when opened: the panel fetches its own paged
                query, and a 30-70 iteration run should not be fetched every
                time someone opens the dialog to edit a prompt. */}
              {showFullLog && (
                <LoopIterationLog
                  slug={slug}
                  boardId={board.id}
                  boardUuid={board.id}
                />
              )}
            </section>

            <section
              data-testid="loop-stop-history"
              className="space-y-2 border-t border-border/70 pt-4"
            >
              <h3 className="text-sm font-medium">
                {t("boardLoop.stopHistory.title")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("boardLoop.stopHistory.hint")}
              </p>
              {transitionsQuery.isError ? (
                <p
                  data-testid="loop-stop-history-error"
                  role="status"
                  className="text-xs text-destructive"
                >
                  {t("boardLoop.stopHistory.error")}
                </p>
              ) : transitionsQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">
                  {t("common.loading")}
                </p>
              ) : (transitionsQuery.data?.transitions.length ?? 0) === 0 ? (
                <p
                  data-testid="loop-stop-history-empty"
                  className="text-xs text-muted-foreground"
                >
                  {t("boardLoop.stopHistory.empty")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {transitionsQuery.data?.transitions.map((transition) => (
                    <LoopTransitionRow
                      key={transition.id}
                      transition={transition}
                    />
                  ))}
                </ul>
              )}
            </section>
          </fieldset>
          </div>

          <DialogFooter className="shrink-0 flex-col gap-2 border-t border-border/70 pt-4 sm:flex-col sm:items-end">
            {hasNewerConfig && <div role="status" className="space-y-2 text-sm"><p>{t("boardLoop.configChanged")}</p><Button type="button" variant="outline" disabled={loopQuery.isFetching || saveLoop.isPending} onClick={() => setRebaseRequested(true)}>{t("boardLoop.reloadKeepEdits")}</Button></div>}
            <FieldError messages={findings.map(formatFinding)} />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!formReady || !isAdmin || saveLoop.isPending || !policy.canSave}>
                {saveLoop.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Binds the shared palette to this dialog's contract: the i18n reads and the
// per-field test ids stay here, so the shared component owns no board vocabulary.
function TemplateVarChips({
  field,
  vars,
  onInsert,
}: {
  field: PromptField;
  vars: readonly string[];
  onInsert: (field: PromptField, name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <TemplateVarPalette
      vars={vars}
      onInsert={(name) => onInsert(field, name)}
      legend={t("boardLoop.template.vars.legend")}
      groupLabel={t("boardLoop.template.vars.legend")}
      titleFor={(name) => t(`boardLoop.template.vars.${name}`)}
      testIdFor={(name) => `loop-template-var-${field}-${name}`}
    />
  );
}

// One flip on the loop's timeline. Stops and starts share the row so the
// pairing reads as a run ("started 09:00 → stopped 16:00 at iteration 42")
// rather than as two unrelated lists.
function LoopTransitionRow({ transition }: { transition: LoopTransition }) {
  const { t } = useTranslation();
  const isStop = !transition.enabled;
  const isRunner = transition.source === "runner";
  const StateIcon = isStop ? StopCircle : Play;
  const SourceIcon = isRunner ? Bot : UserIcon;
  // The runner's own name is the honest attribution for a rail or
  // objective_complete stop; a human flip is credited to the person.
  const actor = isRunner
    ? (transition.agent_name ?? t("boardLoop.stopHistory.sourceRunner"))
    : (transition.actor_name ?? t("boardLoop.stopHistory.sourceHuman"));

  return (
    <li
      data-source={transition.source}
      data-enabled={String(transition.enabled)}
      className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/60 px-2.5 py-1.5 text-xs"
    >
      <StateIcon
        aria-hidden
        className={
          isStop
            ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
            : "mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-success-foreground)]"
        }
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span className="font-medium text-foreground">
            {isStop
              ? t("boardLoop.stopHistory.stopped")
              : t("boardLoop.stopHistory.started")}
          </span>
          <span>{formatDateTime(transition.occurred_at)}</span>
          <span className="inline-flex items-center gap-1">
            <SourceIcon aria-hidden className="h-3 w-3" />
            {actor}
          </span>
          <span>
            {t("boardLoop.stopHistory.atIteration", {
              count: transition.iteration_count,
            })}
          </span>
        </div>
        {transition.reason && (
          <p className="break-words text-foreground">{transition.reason}</p>
        )}
      </div>
    </li>
  );
}

function IterationRow({ execution }: { execution: ExecutionSummary }) {
  const StatusIcon =
    execution.status === "completed"
      ? CheckCircle2
      : execution.status === "failed" || execution.status === "aborted"
        ? XCircle
        : execution.status === "started" || execution.status === "running"
          ? Loader2
          : CircleDashed;
  return (
    <li className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/60 px-2.5 py-1.5 text-xs">
      <StatusIcon
        aria-hidden
        className={
          execution.status === "failed" || execution.status === "aborted"
            ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
            : execution.status === "started" || execution.status === "running"
              ? "mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
              : "mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-success-foreground)]"
        }
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span>{formatDateTime(execution.started_at)}</span>
          {execution.duration_seconds != null && (
            <span>{formatDuration(execution.duration_seconds)}</span>
          )}
        </div>
        {/* output_summary is the ONLY carrier of iteration cost ("cost=$X
            duration=Ys") — the runner sends no structured cost fields, so it
            renders verbatim; cost_usd stays null on these rows. */}
        {execution.output_summary && (
          <p className="break-words">{execution.output_summary}</p>
        )}
      </div>
    </li>
  );
}
