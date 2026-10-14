// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Button } from "../../components/Button";
import { StatePanel } from "../../components/StatePanel";
import { commands, type BoardsOverview } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { showToast } from "../../shell/layers";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { createBoardUrl } from "./create-board-url";

async function openCreateBoard(url: string) {
  const result = await callDaemon(() => commands.openBackplaneUrl(url));
  if (!result.ok) showToast("Couldn’t open Backplane in your browser.", { tone: "error" });
}

const AGENT_TIP = "Or ask Claude Code: “create a Backplane board for this project”.";

/** No board to bind to yet: why one is worth having, and the two ways to get one. */
export function CreateBoardInvite({ catalog }: { catalog: BoardsOverview | null }) {
  const webOrigin = useStoreSelector(statusStore, (status) => status?.account?.web_origin ?? null);
  const url = createBoardUrl(webOrigin, catalog);

  return (
    <StatePanel
      tone="info"
      icon="plus"
      title="Keep real track of your project with Backplane"
      actions={
        url ? (
          <Button variant="primary" trailingIcon="external" onClick={() => void openCreateBoard(url)}>
            Open Backplane to create a board
          </Button>
        ) : null
      }
      finePrint={url ? `${AGENT_TIP} It shows up here when you come back.` : AGENT_TIP}
    >
      <p>Give it a board, and every Claude Code and Codex session here lands on it with its cost and progress. Your agents can work from the same board.</p>
      {url ? null : <p>Create a board in Backplane on the web, then come back here to pick it.</p>}
    </StatePanel>
  );
}
