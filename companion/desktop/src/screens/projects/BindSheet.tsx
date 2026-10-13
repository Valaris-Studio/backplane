// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Listbox, type ListboxGroup } from "../../components/Listbox";
import { PrivacyLevelControl } from "../../components/PrivacyLevelControl";
import type { PrivacyLevel } from "../../components/privacy-levels";
import { SectionHead } from "../../components/SectionHead";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { commands, type BoardsOverview } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { useBoardsCatalog, useMappings } from "../../stores/projects";
import { defaultBindLevel, useRichCaptureOffer } from "../../stores/rich-capture";
import { BOARDS_READY, useBoardsArrival } from "../shared/boards-arrival";
import { CreateBoardInvite } from "../shared/CreateBoardInvite";
import { bind, type BindTarget, type BoardChoice } from "./bind-flow";
import { NO_BOARDS_REACH, failureKind } from "./copy";

const LINKED_BADGE = "Linked to this repo";

function isCatalog(value: unknown): value is BoardsOverview {
  return typeof value === "object" && value !== null && "workspaces" in value && Array.isArray(value.workspaces);
}

type CatalogLoad = { state: "loading" } | { state: "failed"; error: CompanionError } | { state: "loaded"; catalog: BoardsOverview };

/**
 * The shared catalog store keeps its last value and drops failures, so the
 * sheet also asks once itself: that is how it can tell "unreachable" from "loading".
 */
function useCatalogForSheet(): { load: CatalogLoad; retry: () => void } {
  const shared = useBoardsCatalog();
  const [own, setOwn] = useState<CatalogLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void callDaemon(commands.boards).then((result) => {
      if (!current) return;
      if (!result.ok) setOwn({ state: "failed", error: result.error });
      else if (isCatalog(result.value)) setOwn({ state: "loaded", catalog: result.value });
      else setOwn({ state: "failed", error: { kind: "protocol", message: "" } });
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  const load: CatalogLoad = shared ? { state: "loaded", catalog: shared } : own;
  return {
    load,
    retry: () => {
      setOwn({ state: "loading" });
      setAttempt((count) => count + 1);
    },
  };
}

function catalogGroups(catalog: BoardsOverview, linkedBoardIds: ReadonlySet<string>): ListboxGroup[] {
  return catalog.workspaces
    .filter((workspace) => workspace.boards.length > 0)
    .map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      options: workspace.boards.map((board) => ({
        value: board.id,
        label: board.name,
        description: board.repos.length > 0 ? board.repos.join(", ") : "No linked repository",
        ...(linkedBoardIds.has(board.id) ? { badge: LINKED_BADGE } : {}),
      })),
    }));
}

function choiceFor(catalog: BoardsOverview, boardId: string): BoardChoice | null {
  for (const workspace of catalog.workspaces) {
    const board = workspace.boards.find((candidate) => candidate.id === boardId);
    if (board) return { workspaceId: workspace.id, boardId: board.id, boardName: board.name };
  }
  return null;
}

function catalogFailure(error: CompanionError): string {
  return failureKind(error) === "daemon_down"
    ? "The Companion service isn’t running, so your boards can’t be listed right now."
    : "Backplane can’t be reached, so your boards can’t be listed right now.";
}

export interface BindSheetProps {
  target: BindTarget;
  close: () => void;
  opener: HTMLElement | null;
  onBound: () => void;
}

export function BindSheet({ target, close, opener, onBound }: BindSheetProps) {
  const { load, retry } = useCatalogForSheet();
  const mappings = useMappings();
  const [boardId, setBoardId] = useState<string | null>(null);
  const richOffer = useRichCaptureOffer();
  // Until the owner picks, the level follows what this Backplane offers.
  const [pickedLevel, setLevel] = useState<PrivacyLevel | null>(null);
  const level = pickedLevel ?? defaultBindLevel(richOffer);
  const [binding, setBinding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const bindButtonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Listbox owns its search input; the sheet opens with focus there.
  const searchRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return pickerRef.current?.querySelector<HTMLElement>('[role="combobox"]') ?? null;
      },
    }),
    [],
  );

  const linked = useMemo(() => new Set(target.linkedBoardIds), [target.linkedBoardIds]);
  const catalog = load.state === "loaded" ? load.catalog : null;
  const groups = useMemo(() => (catalog ? catalogGroups(catalog, linked) : []), [catalog, linked]);
  const choice = catalog && boardId ? choiceFor(catalog, boardId) : null;
  const noBoardsYet = catalog !== null && groups.length === 0;
  const boardsArrived = useBoardsArrival(noBoardsYet, pickerRef);

  const submit = async () => {
    if (!choice || binding) return;
    setBinding(true);
    setFailure(null);
    const outcome = await bind(target, choice, level, mappings, bindButtonRef.current);
    setBinding(false);
    if (outcome.status === "failed") setFailure(outcome.message);
    if (outcome.status !== "bound") return;
    close();
    onBound();
  };

  return (
    <Sheet
      title={`Bind ${target.name}`}
      onClose={close}
      initialFocusRef={searchRef}
      returnFocusTo={opener}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button ref={bindButtonRef} variant="primary" disabled={!choice} loading={binding} onClick={() => void submit()}>
            Bind
          </Button>
        </>
      }
    >
      <p role="status" className="sr-only">
        {boardsArrived ? BOARDS_READY : ""}
      </p>
      <div ref={pickerRef}>
        {noBoardsYet ? (
          <CreateBoardInvite catalog={catalog} />
        ) : load.state === "loaded" ? (
          <Listbox
            searchLabel="Search boards"
            listLabel="Boards"
            placeholder="Search boards"
            groups={groups}
            value={boardId}
            onValueChange={(value) => {
              setBoardId(value);
              setFailure(null);
            }}
            emptyState={(query) => `No boards match “${query}”. ${NO_BOARDS_REACH}`}
          />
        ) : load.state === "loading" ? (
          <p className="projects-loading">
            <Spinner /> Loading boards…
          </p>
        ) : (
          <Banner
            tone="warning"
            title={catalogFailure(load.error)}
            actions={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          />
        )}
      </div>
      {noBoardsYet ? null : (
        <>
          <SectionHead title="What’s sent" />
          <PrivacyLevelControl value={level} onValueChange={setLevel} richOffer={richOffer} defaulted={pickedLevel === null} />
        </>
      )}
      {failure ? (
        <div className="projects-sheet-error">
          <Banner tone="error" role="alert" title={failure} />
        </div>
      ) : null}
    </Sheet>
  );
}
