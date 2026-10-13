// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

import { Banner } from "../../components/Banner";
import { Button, LinkButton } from "../../components/Button";
import { Group } from "../../components/Group";
import { Icon } from "../../components/Icon";
import { Pill } from "../../components/Pill";
import { PrivacyLevelControl } from "../../components/PrivacyLevelControl";
import { PRIVACY_LEVEL_COPY, type PrivacyLevel } from "../../components/privacy-levels";
import { defaultBindLevel, useRichCaptureOffer } from "../../stores/rich-capture";
import { SectionHead } from "../../components/SectionHead";
import { Spinner } from "../../components/Spinner";
import { StatePanel } from "../../components/StatePanel";
import { commands, type DiscoveredProject } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { useSheet } from "../../shell/layers";
import { applyProjectsEvent, overviewResource } from "../../stores/projects";
import { addProjectFolder } from "../shared/add-project-folder";
import { useDisplayPath } from "../shared/display-path";
import { BindSheet } from "./BindSheet";
import { DaemonDownPanel } from "./DaemonDownPanel";
import { errorSentence, isDaemonDown } from "./daemon-messages";
import { useStoreSelector } from "../../stores/external-store";
import { goToStep, onboardingStore, updateProjects, type ProjectOutcome } from "./onboarding-store";
import { OnboardingFrame } from "./OnboardingFrame";
import { bindProject, projectName } from "./project-binding";

type Outcome = ProjectOutcome;

interface ProjectRowProps {
  project: DiscoveredProject;
  defaultLevel: PrivacyLevel;
  outcome: Outcome | undefined;
  onOutcome: (outcome: Outcome) => void;
}

function ProjectRow({ project, defaultLevel, outcome, onOutcome }: ProjectRowProps) {
  const sheet = useSheet();
  const nameId = useId();
  const name = projectName(project);
  // A no-break space holds the line while Rust masks the path, so the row never grows.
  const shownRoot = useDisplayPath(project.root) ?? "\u00a0";
  const candidates = project.candidates ?? [];
  // One candidate is a suggestion; several are a choice the user makes in the sheet.
  const suggestion = candidates.length === 1 ? candidates[0] : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const focusRowOnOutcome = useRef(false);

  // Bind and Skip remove the button that had focus; the row keeps it instead of the page body.
  useLayoutEffect(() => {
    if (!outcome || !focusRowOnOutcome.current) return;
    focusRowOnOutcome.current = false;
    rowRef.current?.focus({ preventScroll: true });
  }, [outcome]);

  const settle = (next: Outcome) => {
    focusRowOnOutcome.current = true;
    onOutcome(next);
  };

  const bindSuggestion = async () => {
    if (!suggestion) return;
    setBusy(true);
    setError(null);
    const failure = await bindProject(project, suggestion, defaultLevel);
    setBusy(false);
    if (failure) setError(`Couldn’t bind ${name}. ${errorSentence(failure)}`);
    else settle({ kind: "bound", level: defaultLevel });
  };

  const chooseBoard = (event: MouseEvent<HTMLButtonElement>) => {
    const opener = event.currentTarget;
    sheet.present(({ close }) => (
      <BindSheet
        project={project}
        initialLevel={defaultLevel}
        returnFocusTo={opener}
        onClose={close}
        onBound={(level) => {
          settle({ kind: "bound", level });
          close();
        }}
      />
    ));
  };

  return (
    <li ref={rowRef} className="ob-proj" aria-labelledby={nameId} tabIndex={-1} data-row-key={project.root}>
      <div className="ob-proj-head">
        <Icon name="folder" />
        <div className="ob-proj-name">
          <b id={nameId}>{name}</b>
          <small>{shownRoot}</small>
        </div>
        {outcome?.kind === "bound" ? <Pill tone="success">Bound</Pill> : outcome?.kind === "skipped" ? <Pill>Skipped</Pill> : null}
      </div>
      {suggestion ? (
        <div className="ob-proj-board">
          <Icon name="arrow" />
          <span>
            <b>{suggestion.board_name}</b> · {suggestion.workspace_name}
          </span>
          {outcome?.kind === "bound" ? null : <span className="bp-badge">Suggested</span>}
        </div>
      ) : outcome?.kind === "bound" ? null : (
        <p className="ob-explain">{candidates.length > 1 ? `Linked to ${candidates.length} boards. Choose one.` : "No board is linked to this repository."}</p>
      )}
      {outcome?.kind === "bound" ? (
        <p className="ob-explain">Captured with the {PRIVACY_LEVEL_COPY[outcome.level].label} level. Change it any time in Projects.</p>
      ) : outcome?.kind === "skipped" ? null : (
        <div className="bp-btn-row ob-proj-actions">
          {suggestion ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void bindSuggestion()}>
              Bind
            </Button>
          ) : (
            <Button size="sm" onClick={chooseBoard}>
              Choose board…
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => settle({ kind: "skipped" })}>
            Skip
          </Button>
        </div>
      )}
      {error ? (
        <p className="ob-explain ob-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

type Fetch = { kind: "loading" } | { kind: "failed"; error: CompanionError };

// Excluded folders match the user's own exclude globs; offering them here would contradict that choice.
function bindable(discovered: readonly DiscoveredProject[]): DiscoveredProject[] {
  return discovered.filter((project) => project.reason !== "excluded");
}

/**
 * The rows are a snapshot taken when the step first opens, kept in the
 * onboarding store with the labels: a bound repository leaves `discovered`
 * as soon as the policy refreshes, and a daemon drop unmounts this screen;
 * neither may lose a row or its "Bound". The shared store is used when it
 * already holds the list, and fed when this step had to fetch it (the store
 * keeps fetch errors to itself, and this step has to show them).
 */
/** A folder the user added: its row joins the snapshot (once) and takes focus when it renders. */
function useAddFolder() {
  const [addError, setAddError] = useState<string | null>(null);
  const pendingRoot = useRef<string | null>(null);
  const rows = useStoreSelector(onboardingStore, (state) => state.projects.rows);

  const focusPending = () => {
    if (pendingRoot.current === null) return;
    const row = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(pendingRoot.current)}"]`);
    if (!row) return;
    pendingRoot.current = null;
    row.focus();
  };
  useLayoutEffect(focusPending, [rows]);

  const addFolder = async () => {
    setAddError(null);
    const outcome = await addProjectFolder();
    if (outcome.status === "failed") setAddError(outcome.message);
    if (outcome.status !== "added") return;
    const { project } = outcome;
    pendingRoot.current = project.root;
    updateProjects((progress) => {
      const current = progress.rows ?? [];
      return current.some((row) => row.root === project.root) ? progress : { ...progress, rows: [...current, project] };
    });
    focusPending();
  };

  return { addError, addFolder: () => void addFolder() };
}

export function ProjectsStep() {
  const { rows, outcomes, defaultLevel: pickedLevel } = useStoreSelector(onboardingStore, (state) => state.projects);
  const richOffer = useRichCaptureOffer();
  const defaultLevel = pickedLevel ?? defaultBindLevel(richOffer);
  const [fetchState, setFetchState] = useState<Fetch>({ kind: "loading" });
  const [loadRequest, setLoadRequest] = useState(0);
  const { addError, addFolder } = useAddFolder();
  const needsRows = rows === null;

  useEffect(() => {
    if (!needsRows) return;
    const cached = overviewResource.store.get();
    if (cached) {
      updateProjects((progress) => ({ ...progress, rows: bindable(cached.discovered) }));
      return;
    }
    let cancelled = false;
    void callDaemon(() => commands.projects()).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        // Same parse-and-store path as the stream's `projects` event; ensure() then marks it wanted (see store-feed.ts).
        applyProjectsEvent(result.value);
        overviewResource.ensure();
        updateProjects((progress) => ({ ...progress, rows: bindable(result.value.discovered) }));
      } else {
        setFetchState({ kind: "failed", error: result.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsRows, loadRequest]);

  const retry = () => {
    setFetchState({ kind: "loading" });
    setLoadRequest((request) => request + 1);
  };

  let body;
  if (rows === null && fetchState.kind === "loading")
    body = (
      <p className="ob-loading">
        <Spinner />
        Looking for projects…
      </p>
    );
  else if (rows === null && fetchState.kind === "failed" && isDaemonDown(fetchState.error)) body = <DaemonDownPanel onRetry={retry} />;
  else if (rows === null && fetchState.kind === "failed")
    body = (
      <Banner
        tone="error"
        role="alert"
        title="Couldn’t read your projects"
        actions={
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        }
      >
        {fetchState.kind === "failed" ? errorSentence(fetchState.error) : null}
      </Banner>
    );
  else if (rows === null || rows.length === 0)
    body = (
      <StatePanel
        icon="folder"
        title="No projects yet"
        actions={
          <Button size="sm" onClick={addFolder}>
            Add a folder…
          </Button>
        }
      >
        Add a folder, or just start Claude Code or Codex in a repo and it shows up here.
      </StatePanel>
    );
  else
    body = (
      <>
        <SectionHead
          title="Repositories"
          action={
            <LinkButton icon="plus" iconPosition="start" onClick={addFolder}>
              Add a folder…
            </LinkButton>
          }
        />
        <Group label="Repositories">
          {rows.map((project) => (
            <ProjectRow
              key={project.root}
              project={project}
              defaultLevel={defaultLevel}
              outcome={outcomes[project.root]}
              onOutcome={(outcome) => updateProjects((progress) => ({ ...progress, outcomes: { ...progress.outcomes, [project.root]: outcome } }))}
            />
          ))}
        </Group>
      </>
    );

  const finish = () => goToStep("done", "push");

  return (
    <OnboardingFrame
      step="projects"
      title="Bind your first projects"
      lede="These git repositories had agent activity recently. Only the ones you bind are captured."
      onBack={() => goToStep("agents", "pop")}
      actions={
        <>
          <Button onClick={finish}>Later</Button>
          <Button variant="primary" onClick={finish}>
            Continue
          </Button>
        </>
      }
    >
      <SectionHead title="Sent by default" />
      <PrivacyLevelControl
        label="Sent by default"
        value={defaultLevel}
        onValueChange={(level) => updateProjects((progress) => ({ ...progress, defaultLevel: level }))}
        richOffer={richOffer}
        defaulted={pickedLevel === null}
      />
      {body}
      {addError ? (
        <p className="ob-explain ob-add-error ob-error" role="alert">
          {addError}
        </p>
      ) : null}
    </OnboardingFrame>
  );
}
