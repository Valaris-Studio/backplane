// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button, LinkButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { StatePanel } from "../../components/StatePanel";
import { commands, type BoardCandidate, type BoardsOverview, type DiscoveredProject } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { MotionListItem } from "../../motion/MotionListItem";
import { platformCopy } from "../../platform/copy";
import { showToast } from "../../shell/layers";
import { overviewResource, type ProjectMapping } from "../../stores/projects";
import { defaultBindLevel, useRichCaptureOffer } from "../../stores/rich-capture";
import { bind, bindTargetFor, reasonOf } from "./bind-flow";
import { openBindSheet } from "./open-bind-sheet";
import { countWord, failureReason, reasonChip } from "./copy";
import { useLeavingRowFocus } from "./leaving-focus";
import { addProjectFolder } from "../shared/add-project-folder";
import { useDisplayPath } from "../shared/display-path";
import { folderName } from "./paths";
import { safeRepo } from "./repo";
import { SectionHeading } from "./SectionHeading";

const FOCUS_PREFIX = "found:";

function candidatesOf(project: DiscoveredProject): readonly BoardCandidate[] {
  return project.candidates ?? [];
}

function joinNames(names: readonly string[]): ReactNode {
  return names.map((name, index) => (
    <span key={`${index}-${name}`}>
      {index === 0 ? "" : index === names.length - 1 ? " and " : ", "}
      <b>{name}</b>
    </span>
  ));
}

function Explanation({ project }: { project: DiscoveredProject }) {
  const candidates = candidatesOf(project);
  switch (reasonOf(project)) {
    case "auto_match_off": {
      const [first] = candidates;
      return first ? (
        <>
          Its remote is linked to <b>{first.board_name}</b>, but automatic binding is off.
        </>
      ) : (
        <>Its remote is linked to a board, but automatic binding is off.</>
      );
    }
    case "ambiguous":
      return candidates.length >= 2 ? (
        <>
          Its remote is linked to {countWord(candidates.length)} boards: {joinNames(candidates.map((candidate) => candidate.board_name))}. Choose one.
        </>
      ) : (
        <>Its remote is linked to several boards. Choose one.</>
      );
    case "excluded":
      return <>Matches one of your never-capture rules, so it is never captured.</>;
    case "no_origin":
      return <>This folder has no git remote, so no board can match it.</>;
    default: {
      const repo = safeRepo(project.repo_url);
      return repo ? (
        <>
          No board is linked to <code>{repo}</code>. Pick one to start capturing.
        </>
      ) : (
        <>No board is linked to this repository. Pick one to start capturing.</>
      );
    }
  }
}

// What the two sheet buttons do differently: a repo binds by its remote, a folder by its path.
const SCOPE_BY_REMOTE = "Binds by remote: any clone of this repo is captured.";
const SCOPE_BY_PATH = "Binds by path: only this folder is captured.";

interface FoundRowActions {
  openSheet: (project: DiscoveredProject, opener: HTMLElement) => void;
  bindToCandidate: (project: DiscoveredProject, candidate: BoardCandidate, button: HTMLElement) => void;
  ignore: (project: DiscoveredProject) => void;
  editRules: () => void;
}

interface FoundRowProps {
  project: DiscoveredProject;
  /** A bind or ignore of this row is running: every action waits. */
  busy: boolean;
  actions: FoundRowActions;
  onFocusCapture: () => void;
}

function FoundRow({ project, busy, actions, onFocusCapture }: FoundRowProps) {
  // A no-break space holds the line while Rust masks the path, so the row never grows.
  const shownRoot = useDisplayPath(project.root) ?? "\u00a0";
  const nameId = useId();
  // aria-disabled, not disabled: a disabled button drops focus, and the row may be about to leave.
  const lock = { "aria-disabled": busy ? true : undefined };
  const reason = reasonOf(project);
  const candidates = candidatesOf(project);
  const chip = reasonChip(reason);
  const focusKey = FOCUS_PREFIX + project.root;
  const first = { "data-focus-key": focusKey, "aria-describedby": nameId, size: "sm" as const, ...lock };
  const sheetButton = (label: string) => (
    <Button {...first} variant="primary" onClick={(event) => actions.openSheet(project, event.currentTarget)}>
      {label}
    </Button>
  );
  const [candidate] = candidates;

  const scopeLine = reason === "excluded" ? null : reason === "no_origin" || !safeRepo(project.repo_url) ? SCOPE_BY_PATH : SCOPE_BY_REMOTE;
  let primary: ReactNode;
  switch (reason) {
    case "auto_match_off":
      primary = candidate ? (
        <>
          <Button {...first} variant="primary" onClick={(event) => actions.bindToCandidate(project, candidate, event.currentTarget)}>
            Bind to {candidate.board_name}
          </Button>
          <Button size="sm" aria-describedby={nameId} {...lock} onClick={(event) => actions.openSheet(project, event.currentTarget)}>
            Other board…
          </Button>
        </>
      ) : (
        sheetButton("Bind to board…")
      );
      break;
    case "ambiguous":
      primary = sheetButton("Choose board…");
      break;
    case "excluded":
      primary = (
        <Button {...first} onClick={() => !busy && actions.editRules()}>
          Edit rules
        </Button>
      );
      break;
    case "no_origin":
      primary = sheetButton("Bind folder…");
      break;
    default:
      primary = sheetButton("Bind to board…");
  }

  return (
    <MotionListItem className="projects-proj" data-row-key={project.root} onFocusCapture={onFocusCapture}>
      <div className="projects-proj-head">
        <Icon name="folder" />
        <div className="projects-proj-name">
          <b id={nameId}>{folderName(project.root)}</b>
          <small>{shownRoot}</small>
        </div>
        <span className="projects-reason" data-warn={chip.warn ? "true" : undefined}>
          {chip.label(candidates.length)}
        </span>
      </div>
      <p className="projects-explain">
        <Explanation project={project} />
      </p>
      {scopeLine ? <p className="projects-scope">{scopeLine}</p> : null}
      <div className="bp-btn-row projects-actions">
        {primary}
        <Button size="sm" aria-describedby={nameId} {...lock} onClick={() => actions.ignore(project)}>
          Ignore
        </Button>
      </div>
    </MotionListItem>
  );
}

interface FoundPanelProps {
  projects: readonly DiscoveredProject[];
  mappings: readonly ProjectMapping[];
  catalog: BoardsOverview | null;
  onEditRules: () => void;
  /** Takes a row out of the list at once, before the daemon's next projects list confirms it. */
  onLeave: (root: string) => void;
}

/**
 * A folder added with "Add a folder…" gets focus on its row's first action once
 * the list shows it: at once when it was already listed, else when the daemon's
 * `projects` event (or the refetch) brings it in.
 */
function useFocusAddedRow(projects: readonly DiscoveredProject[]) {
  const pendingRoot = useRef<string | null>(null);
  const focusPending = () => {
    if (pendingRoot.current === null) return;
    const action = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(FOCUS_PREFIX + pendingRoot.current)}"]`);
    if (!action) return;
    pendingRoot.current = null;
    action.focus();
  };
  useLayoutEffect(focusPending, [projects]);
  return (root: string) => {
    pendingRoot.current = root;
    focusPending();
  };
}

export function FoundPanel({ projects, mappings, catalog, onEditRules, onLeave }: FoundPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keys = projects.map((project) => project.root);
  const focusFromLeavingRow = useLeavingRowFocus(keys, FOCUS_PREFIX, headingRef);
  const focusAddedRow = useFocusAddedRow(projects);
  const richOffer = useRichCaptureOffer();

  const addFolder = async () => {
    const outcome = await addProjectFolder();
    if (outcome.status === "failed") showToast(outcome.message, { tone: "error" });
    if (outcome.status !== "added") return;
    focusAddedRow(outcome.project.root);
    overviewResource.invalidate();
  };

  const [busyRoots, setBusyRoots] = useState<ReadonlySet<string>>(() => new Set());
  // Read at click time: a second press can arrive before the re-render that marks the row busy.
  const busyNow = useRef(new Set<string>());
  const whileBusy = (root: string, work: () => Promise<void>) => {
    if (busyNow.current.has(root)) return;
    busyNow.current.add(root);
    setBusyRoots(new Set(busyNow.current));
    void work().finally(() => {
      busyNow.current.delete(root);
      setBusyRoots(new Set(busyNow.current));
    });
  };

  const actions: FoundRowActions = {
    openSheet: (project, opener) => {
      if (busyNow.current.has(project.root)) return;
      openBindSheet(bindTargetFor(project, catalog), opener, () => onLeave(project.root));
    },
    bindToCandidate: (project, candidate, button) =>
      whileBusy(project.root, async () => {
        const target = bindTargetFor(project, catalog);
        const choice = { workspaceId: candidate.workspace_id, boardId: candidate.board_id, boardName: candidate.board_name };
        const outcome = await bind(target, choice, defaultBindLevel(richOffer), mappings, button);
        if (outcome.status === "bound") onLeave(project.root);
        else if (outcome.status === "failed") showToast(outcome.message, { tone: "error" });
      }),
    ignore: (project) =>
      whileBusy(project.root, async () => {
        const result = await callDaemon(() => commands.projectIgnore(project.root));
        if (result.ok) {
          onLeave(project.root);
          overviewResource.invalidate();
        } else {
          showToast(`Couldn’t ignore ${folderName(project.root)}. ${failureReason(result.error)}`, { tone: "error" });
        }
      }),
    editRules: onEditRules,
  };

  return (
    <section>
      <SectionHeading
        title="Not captured yet"
        headingRef={headingRef}
        action={
          <LinkButton icon="plus" iconPosition="start" onClick={() => void addFolder()}>
            Add a folder…
          </LinkButton>
        }
      />
      <ul className="bp-group projects-list" aria-label="Found folders">
        <AnimatePresence initial={false}>
          {projects.map((project) => (
            <FoundRow key={project.root} project={project} busy={busyRoots.has(project.root)} actions={actions} onFocusCapture={() => focusFromLeavingRow(project.root)} />
          ))}
        </AnimatePresence>
      </ul>
      {projects.length === 0 ? (
        <StatePanel
          icon="folder"
          title="Nothing waiting yet"
          actions={
            <Button size="sm" onClick={() => void addFolder()}>
              Add a folder…
            </Button>
          }
        >
          Add a folder, or just start Claude Code or Codex in a repo and it shows up here.
        </StatePanel>
      ) : null}
      <p className="bp-help">{`Nothing from these folders leaves ${platformCopy().thisDevice} until you bind them.`}</p>
    </section>
  );
}
