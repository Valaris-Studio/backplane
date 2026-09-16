// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Rocket, Stethoscope, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WizardSteps } from "@/components/ui/wizard-steps";
import { fadeInUp } from "@/lib/animations";
import { useCreateAgent } from "../../hooks/useAgentMetrics";
import { useWorkspaceConfig } from "../../hooks/useWorkspaceConfig";
import { useTeams, useCreateTeam, useAddTeamMember } from "../../hooks/useTeams";
import { useBoards } from "@/features/kanban/api/use-boards";
import { useRunnerConfig } from "@/features/git/api/use-runner-config";
import { runnerConfigShellPath } from "../../utils/runnerConfigPath";
import { downloadAgentConfigBundle } from "../../utils/exportConfig";
import type { AgentCreated } from "../../api/agents";
import { RoleCombobox } from "../teams/RoleCombobox";
import { RunnerConfigFiles } from "./RunnerConfigFiles";
import { CopyableField } from "./CopyableField";
import { GetRunnerBlock } from "./GetRunnerBlock";

interface LaunchRunnerWizardProps {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "identity" | "bind" | "config" | "launch";
const STEP_ORDER: Step[] = ["identity", "bind", "config", "launch"];

// One guided journey that unifies the previously-scattered runner onboarding:
// create identity (+ key shown once) → bind roles (so it isn't orphaned) → get
// config files → copy the launch command and watch it connect. This is the
// legibility fix — an end-user can go from zero to a running runner here.
export function LaunchRunnerWizard({ slug, open, onOpenChange }: LaunchRunnerWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("identity");
  const [created, setCreated] = useState<AgentCreated | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  // Deferred past the dialog's exit tween (~180ms): a synchronous reset used
  // to flip the content back to step 1 while the dialog was still fading out.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      setStep("identity");
      setCreated(null);
      setKeySaved(false);
      setConfirmClose(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [open]);

  // Same step-change entrance as McpConnectionWizard, so the two wizards move
  // with one voice.
  useEffect(() => {
    if (!open || !paneRef.current) return;
    fadeInUp(paneRef.current, { offset: 8, duration: 0.22 });
  }, [open, step]);

  const unsavedKey = !!created?.raw_api_key && !keySaved;
  useEffect(() => {
    if (!open || !unsavedKey) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, unsavedKey]);

  const close = () => {
    if (busy) return;
    if (unsavedKey) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(false);
  };

  const advance = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]!);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      {/* The shared DialogContent deliberately omits role="dialog" — set it
          here so assistive tech sees a dialog (McpConnectionWizard precedent). */}
      <DialogContent role="dialog" aria-modal="true" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" />
            {t("runner.launchWizard.title")}
          </DialogTitle>
          <DialogDescription>{t("runner.launchWizard.subtitle")}</DialogDescription>
        </DialogHeader>

        <StepIndicator step={step} />

        <div ref={paneRef} data-testid="wizard-pane">
          {step === "identity" ? (
            <IdentityStep
              slug={slug}
              onBusyChange={setBusy}
              onCreated={(agent) => {
                setCreated(agent);
                if (agent.raw_api_key === null) {
                  // Idempotent reactivation — no key ceremony; move on.
                  toast.success(t("agents.runnerReactivated"));
                  setStep("bind");
                }
              }}
              created={created}
              onContinue={() => {
                setKeySaved(true);
                setConfirmClose(false);
                setStep("bind");
              }}
            />
          ) : step === "bind" ? (
            <BindStep slug={slug} agent={created} onNext={advance} onBusyChange={setBusy} />
          ) : step === "config" ? (
            <ConfigStep slug={slug} agent={created} onNext={advance} />
          ) : (
            <LaunchStep agent={created} onDone={close} onBack={() => setStep("config")} />
          )}
        </div>
        {confirmClose && (
          <div role="alert" className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm">{t("runner.launchWizard.unsavedKey")}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setConfirmClose(false)}>
                {t("runner.launchWizard.keepKey")}
              </Button>
              <Button variant="destructive" data-testid="wizard-discard-key" onClick={() => onOpenChange(false)}>
                {t("runner.launchWizard.discardKey")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const { t } = useTranslation();
  const labels: Record<Step, string> = {
    identity: t("runner.launchWizard.stepIdentity"),
    bind: t("runner.launchWizard.stepBind"),
    config: t("runner.launchWizard.stepConfig"),
    launch: t("runner.launchWizard.stepLaunch"),
  };
  return (
    <WizardSteps
      aria-label={t("a11y.agents.launchWizardSteps")}
      steps={STEP_ORDER.map((id) => ({ id, label: labels[id] }))}
      currentIndex={STEP_ORDER.indexOf(step)}
    />
  );
}

// The one-time key ceremony swaps in place of the create form — a high-stakes
// reveal that deserves a bridge, not a teleport.
function KeyReveal({ children }: { children: ReactNode }) {
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!revealRef.current) return;
    fadeInUp(revealRef.current, { offset: 6, duration: 0.2 });
  }, []);

  return (
    <div ref={revealRef} className="space-y-4">
      {children}
    </div>
  );
}

function IdentityStep({
  slug,
  created,
  onCreated,
  onContinue,
  onBusyChange,
}: {
  slug: string;
  created: AgentCreated | null;
  onCreated: (agent: AgentCreated) => void;
  onContinue: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const createAgent = useCreateAgent(slug);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    onBusyChange(createAgent.isPending);
    return () => onBusyChange(false);
  }, [createAgent.isPending, onBusyChange]);

  // Key already revealed (created with a raw key) → show the save-your-key panel.
  if (created && created.raw_api_key) {
    return (
      <KeyReveal>
        <CopyableField
          label={t("agents.apiKey")}
          value={created.raw_api_key}
          testid="wizard-api-key"
        />
        <p className="text-xs text-[color:var(--color-warning)]">
          {t("agents.apiKeyWarning")}
        </p>
        <DialogFooter>
          <Button onClick={onContinue} data-testid="wizard-next">
            {t("runner.launchWizard.keySaved")}
          </Button>
        </DialogFooter>
      </KeyReveal>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        createAgent.mutate(
          { name, agent_type: "coding", description: description || undefined, allowed_workspaces: [slug] },
          { onSuccess: onCreated },
        );
      }}
      className="space-y-4"
    >
      <div>
        <label
          htmlFor="wizard-runner-name"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          {t("agents.agentName")}
        </label>
        <Input
          id="wizard-runner-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("agents.agentNamePlaceholder")}
          data-testid="wizard-runner-name"
        />
      </div>
      <div>
        <label
          htmlFor="wizard-runner-description"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          {t("agents.description")}
        </label>
        <Input
          id="wizard-runner-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("agents.descriptionPlaceholder")}
        />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!name || createAgent.isPending} data-testid="wizard-create">
          {createAgent.isPending ? t("common.saving") : t("runner.launchWizard.createRunner")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function BindStep({
  slug,
  agent,
  onNext,
  onBusyChange,
}: {
  slug: string;
  agent: AgentCreated | null;
  onNext: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data: config } = useWorkspaceConfig(slug);
  const { data: teams, isPending: teamsPending, isError: teamsError, refetch: retryTeams } = useTeams(slug);
  const { data: boards } = useBoards(slug);
  const createTeam = useCreateTeam(slug);
  const addMember = useAddTeamMember(slug);
  const [roles, setRoles] = useState<string[]>([]);
  const binding = createTeam.isPending || addMember.isPending;
  const [bindError, setBindError] = useState(false);
  useEffect(() => {
    onBusyChange(binding);
    return () => onBusyChange(false);
  }, [binding, onBusyChange]);

  // A team's board_id is one board or null (= every board in the workspace),
  // and the runner picks up work accordingly — so the step says which before
  // Next commits it. Withheld until teams resolve: the "creates a team" line
  // would be a lie while the list is still loading.
  const existingTeam = teams?.[0];
  const scopeLine = !teams || teamsError || teamsPending
    ? null
    : !existingTeam
      ? t("runner.launchWizard.bindScopeNewTeam", {
          team: t("runner.launchWizard.defaultTeamName"),
        })
      : existingTeam.board_id
        ? t("runner.launchWizard.bindScopeBoard", {
            team: existingTeam.name,
            board:
              boards?.find((board) => board.id === existingTeam.board_id)?.name ??
              existingTeam.board_id,
          })
        : t("runner.launchWizard.bindScopeWorkspace", { team: existingTeam.name });

  const suggestions = useMemo(
    () => config?.pipeline_config?.stages.map((s) => s.role) ?? [],
    [config],
  );

  // Next ALWAYS binds — zero selected roles binds with roles: [], the
  // scheduler's all-roles semantics. An unbound runner (no team membership)
  // exits fatal with "platform returned no pipeline_config", so only the
  // explicit Skip may leave the runner team-less, and it says so.
  const bindAndNext = () => {
    if (!teams || teamsPending || teamsError || binding) return;
    setBindError(false);
    if (!agent) {
      onNext();
      return;
    }
    const existing = teams?.[0];
    const doAdd = (teamId: string, teamName: string) =>
      addMember.mutate(
        { teamId, data: { agent_id: agent.id, roles }, memberName: agent.name, teamName },
        { onSuccess: onNext, onError: () => setBindError(true) },
      );
    if (existing) {
      doAdd(existing.id, existing.name);
    } else {
      createTeam.mutate(
        { name: t("runner.launchWizard.defaultTeamName") },
        { onSuccess: (team) => doAdd(team.id, team.name), onError: () => setBindError(true) },
      );
    }
  };

  return (
    <div className="space-y-4" data-testid="wizard-step-bind">
      <p className="text-sm text-muted-foreground">{t("runner.launchWizard.bindHint")}</p>
      {teamsPending && <p role="status">{t("common.loading")}</p>}
      {teamsError && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t("runner.launchWizard.teamsError")}</p>
          <Button variant="outline" onClick={() => void retryTeams()}>{t("runners.retry")}</Button>
        </div>
      )}
      {bindError && (
        <p role="alert" className="text-sm text-destructive">{t("runner.launchWizard.bindError")}</p>
      )}
      {scopeLine ? (
        <p className="text-xs text-muted-foreground" data-testid="wizard-bind-scope">
          {scopeLine}
        </p>
      ) : null}
      <RoleCombobox
        suggestions={suggestions}
        selectedRoles={roles}
        onAdd={(r) => setRoles((prev) => [...prev, r])}
        onRemove={(r) => setRoles((prev) => prev.filter((x) => x !== r))}
      />
      {roles.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="wizard-bind-all-roles-hint"
        >
          {t("runner.launchWizard.noRolesBindHint")}
        </p>
      ) : null}
      <p
        className="text-xs text-muted-foreground"
        data-testid="wizard-skip-warning"
      >
        {t("runner.launchWizard.skipWarning")}
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onNext} disabled={binding} data-testid="wizard-skip">
          {t("runner.launchWizard.skip")}
        </Button>
        <Button
          onClick={bindAndNext}
          disabled={!teams || teamsPending || teamsError || binding}
          data-testid="wizard-next"
        >
          {t("runner.launchWizard.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ConfigStep({
  slug,
  agent,
  onNext,
}: {
  slug: string;
  agent: AgentCreated | null;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const { data: boards, isPending: boardsPending, isError: boardsError, refetch: retryBoards } = useBoards(slug);
  const [boardId, setBoardId] = useState<string>("");
  const effectiveBoard = boardId || boards?.[0]?.id || "";
  // The runner was just created (and bound in the prior step) → scope the
  // prerequisites to it so the create/bind items drop out of the checklist.
  const { data, isLoading, isError, refetch } = useRunnerConfig(
    slug,
    effectiveBoard,
    !!effectiveBoard,
    agent?.id ?? null,
  );

  return (
    <div className="space-y-4" data-testid="wizard-step-config">
      {boards && boards.length > 1 ? (
        <div>
          <label
            htmlFor="wizard-board-picker"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            {t("runner.launchWizard.boardPicker")}
          </label>
          <select
            id="wizard-board-picker"
            className="w-full rounded-md border border-border/70 bg-card px-2 py-1.5 text-sm"
            value={effectiveBoard}
            onChange={(e) => setBoardId(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {boardsPending ? (
        <p role="status" data-testid="wizard-boards-pending">{t("common.loading")}</p>
      ) : boardsError ? (
        <div role="alert" className="space-y-2" data-testid="wizard-boards-error">
          <p className="text-sm text-destructive">{t("runner.launchWizard.boardsError")}</p>
          <Button variant="outline" onClick={() => void retryBoards()}>{t("runners.retry")}</Button>
        </div>
      ) : !boards?.length ? (
        <p className="text-sm text-muted-foreground" data-testid="wizard-boards-empty">
          {t("runner.launchWizard.boardsEmpty")}
        </p>
      ) : (
        <RunnerConfigFiles
          data={data}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => void refetch()}
          onDownloadAgentConfig={
            agent ? () => downloadAgentConfigBundle(agent.id, agent.name) : undefined
          }
        />
      )}
      <p className="text-xs text-muted-foreground">{t("runner.launchWizard.configAlternative")}</p>
      <DialogFooter>
        <Button onClick={onNext} data-testid="wizard-next">
          {t("runner.launchWizard.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function LaunchStep({ agent, onDone, onBack }: { agent: AgentCreated | null; onDone: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  // Never interpolate the raw key — copyable commands end up in terminal
  // scrollback and shell history. The secure-load block feeds the env var.
  const configPath = runnerConfigShellPath(agent?.name ?? "runner");
  const command = `VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner -config ${configPath}`;
  // Bare binary → TUI setup wizard, which prompts for its own credentials. It
  // discovers only `runner.yaml`, never the export bundle's `runner-<name>.yaml`.
  const interactiveCommand = "./backplane-runner";

  return (
    <div className="space-y-4" data-testid="wizard-step-launch">
      <GetRunnerBlock />
      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {t("runner.launchWizard.secureLoad")}
        </p>
        <CopyableField
          value="read -s VALARIS_API_KEY && export VALARIS_API_KEY"
          testid="wizard-secure-load"
          mono
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.secureLoadHint")}
        </p>
      </div>
      <div
        className="rounded-lg border border-border/60 bg-muted/20 p-4"
        data-testid="wizard-launch-interactive-block"
      >
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {t("runner.launchWizard.launchInteractive")}
        </p>
        <CopyableField
          value={interactiveCommand}
          testid="wizard-launch-command-interactive"
          mono
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.launchInteractiveHint")}
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {t("runner.launchWizard.launchCommand")}
        </p>
        <CopyableField value={command} testid="wizard-launch-command" mono />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.launchCommandHint")}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{t("runner.launchWizard.waitingHint")}</p>
      <div
        className="rounded-lg border border-border/60 bg-muted/20 p-4"
        data-testid="wizard-doctor-hint"
      >
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Stethoscope className="h-3.5 w-3.5" />
          {t("runner.launchWizard.doctorLabel")}
        </p>
        <CopyableField value={`./backplane-runner -doctor -config ${configPath}`} testid="wizard-doctor-command" mono />
        <p className="mt-2 text-xs text-muted-foreground">
          {t("runner.launchWizard.doctorHint")}
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} data-testid="wizard-back-config">
          {t("runner.launchWizard.stepConfig")}
        </Button>
        <Button onClick={onDone}>{t("common.done")}</Button>
      </DialogFooter>
    </div>
  );
}
