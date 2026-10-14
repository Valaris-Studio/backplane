// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Listbox, type ListboxGroup } from "../../components/Listbox";
import { PrivacyLevelControl } from "../../components/PrivacyLevelControl";
import { useRichCaptureOffer } from "../../stores/rich-capture";
import type { PrivacyLevel } from "../../components/privacy-levels";
import { SectionHead } from "../../components/SectionHead";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { commands, type BoardsOverview, type DiscoveredProject } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { useStoreSelector } from "../../stores/external-store";
import { catalogResource } from "../../stores/projects";
import { useCatalogRefreshOnReturn } from "../shared/catalog-refresh";
import { BOARDS_READY, useBoardsArrival } from "../shared/boards-arrival";
import { CreateBoardInvite } from "../shared/CreateBoardInvite";
import { bindFailureMessage, failureKind } from "../projects/copy";
import { errorSentence } from "./daemon-messages";
import { adoptInto } from "./store-feed";
import { bindProject, projectName } from "./project-binding";

interface BindSheetProps {
  project: DiscoveredProject;
  initialLevel: PrivacyLevel;
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
  onBound: (level: PrivacyLevel) => void;
}

type BoardsLoad = { kind: "loading" } | { kind: "failed"; error: CompanionError } | { kind: "loaded"; overview: BoardsOverview };

function boardGroups(overview: BoardsOverview, linkedBoardIds: ReadonlySet<string>): ListboxGroup[] {
  return overview.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.name,
    options: workspace.boards.map((board) => ({
      value: board.id,
      label: board.name,
      description: board.repos.length > 0 ? board.repos.join(", ") : "No linked repository",
      ...(linkedBoardIds.has(board.id) ? { badge: "Linked to this repo" } : {}),
    })),
  }));
}

function workspaceOf(overview: BoardsOverview, boardId: string): string | null {
  return overview.workspaces.find((workspace) => workspace.boards.some((board) => board.id === boardId))?.id ?? null;
}

/** "Choose board…": every board the owner can reach now, grouped by workspace, with the level to capture at. */
export function BindSheet({ project, initialLevel, returnFocusTo, onClose, onBound }: BindSheetProps) {
  const name = projectName(project);
  // What this sheet's own fetch found; the shared catalog, once it has one, wins.
  const [ownBoards, setBoards] = useState<BoardsLoad>({ kind: "loading" });
  const [loadRequest, setLoadRequest] = useState(0);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [level, setLevel] = useState(initialLevel);
  const richOffer = useRichCaptureOffer();
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<CompanionError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void callDaemon(() => commands.boards()).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        adoptInto(catalogResource, result.value);
        setBoards({ kind: "loaded", overview: result.value });
      } else {
        // A stale list still beats an error; show the failure only when there is nothing to pick from.
        setBoards((current) => (current.kind === "loaded" ? current : { kind: "failed", error: result.error }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadRequest]);

  // A cached catalog shows at once; the fetch above still runs, since reach can change between visits.
  // Coming back from the browser refetches it too, and a failed refetch leaves it as it was.
  useCatalogRefreshOnReturn();
  const sharedCatalog = useStoreSelector(catalogResource.store, (catalog) => catalog);
  const boards: BoardsLoad = sharedCatalog ? { kind: "loaded", overview: sharedCatalog } : ownBoards;

  const bind = async () => {
    if (boards.kind !== "loaded" || boardId === null) return;
    const workspaceId = workspaceOf(boards.overview, boardId);
    if (workspaceId === null) return;
    setBinding(true);
    setBindError(null);
    const failure = await bindProject(project, { workspace_id: workspaceId, board_id: boardId }, level);
    setBinding(false);
    if (failure) setBindError(failure);
    else onBound(level);
  };

  const linkedBoardIds = new Set((project.candidates ?? []).map((candidate) => candidate.board_id));
  const noBoardsYet = boards.kind === "loaded" && boards.overview.workspaces.every((workspace) => workspace.boards.length === 0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const boardsArrived = useBoardsArrival(noBoardsYet, pickerRef);

  return (
    <Sheet
      title={`Bind ${name}`}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={boardId === null} loading={binding} onClick={() => void bind()}>
            Bind
          </Button>
        </>
      }
    >
      <p role="status" className="sr-only">
        {boardsArrived ? BOARDS_READY : ""}
      </p>
      <div ref={pickerRef}>
        {boards.kind === "loading" ? (
          <p className="ob-loading">
            <Spinner />
            Loading your boards…
          </p>
        ) : boards.kind === "failed" ? (
          <Banner
            tone="error"
            role="alert"
            title="Couldn’t load your boards"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setBoards({ kind: "loading" });
                  setLoadRequest((request) => request + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            {errorSentence(boards.error)}
          </Banner>
        ) : noBoardsYet ? (
          <CreateBoardInvite catalog={boards.overview} />
        ) : (
          <Listbox
            searchLabel="Search boards"
            listLabel="Boards"
            placeholder="Search boards"
            groups={boardGroups(boards.overview, linkedBoardIds)}
            value={boardId}
            onValueChange={setBoardId}
            emptyState={(query) => `No boards match “${query}”. You can only bind to boards you can open in Backplane.`}
          />
        )}
      </div>
      {bindError ? (
        <Banner tone="error" role="alert" title={`Couldn’t bind ${name}`}>
          {failureKind(bindError) === "rich_unavailable" ? bindFailureMessage(bindError, name) : errorSentence(bindError)}
        </Banner>
      ) : null}
      {noBoardsYet ? null : (
        <>
          <SectionHead title="What’s sent" />
          <PrivacyLevelControl value={level} onValueChange={setLevel} richOffer={richOffer} />
        </>
      )}
    </Sheet>
  );
}
