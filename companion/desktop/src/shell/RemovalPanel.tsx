// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";

import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { StatePanel } from "../components/StatePanel";
import { commands } from "../ipc/bindings";
import { callDaemon } from "../ipc/daemon";
import { removeCompanion, type Removal } from "../stores/companion-service";
import { platformCopy } from "../platform/copy";
import { useModalLayerOpen } from "./layers";
import { removalFailureSentence, serverNotReachedCopy } from "./removal-copy";

async function quit() {
  await callDaemon(() => commands.quitApp());
}

const quitButton = (
  <Button key="quit" onClick={() => void quit()}>
    Quit
  </Button>
);

function RemovalState({ removal }: { removal: Exclude<Removal, { state: "idle" }> }) {
  const copy = platformCopy();
  switch (removal.state) {
    case "removing":
      return (
        <p className="m-auto flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner />
          Removing Backplane Companion…
        </p>
      );
    case "removed":
      return (
        <StatePanel
          icon="check"
          title={`Backplane Companion was removed from ${copy.thisDevice}`}
          actions={quitButton}
          finePrint={`${copy.deleteAppStep} Sessions already uploaded stay in Backplane.`}
        >
          {removal.serverRevoked ? null : serverNotReachedCopy()}
        </StatePanel>
      );
    case "removal_incomplete":
      return (
        <StatePanel
          tone="warning"
          icon="alert"
          title="Removal may not have finished"
          actions={
            <>
              <Button variant="primary" onClick={() => void removeCompanion()}>
                Try again
              </Button>
              {quitButton}
            </>
          }
        >
          {removal.serverRevoked === false ? (
            <>
              <p>{removalFailureSentence(removal.failure)}</p>
              <p className="mt-2">{serverNotReachedCopy()}</p>
            </>
          ) : (
            removalFailureSentence(removal.failure)
          )}
        </StatePanel>
      );
  }
}

/**
 * The whole panel once Remove Companion has started: no screen, no daemon
 * call and no service start from here on, only what removal left to do.
 */
export function RemovalPanel({ removal }: { removal: Exclude<Removal, { state: "idle" }> }) {
  const layerOpen = useModalLayerOpen();
  const rootRef = useRef<HTMLDivElement>(null);

  // The dialog's opener (in Settings) is gone, so focus lands on this panel when the dialog closes.
  useEffect(() => {
    if (!layerOpen) rootRef.current?.focus({ preventScroll: true });
  }, [layerOpen, removal.state]);

  return (
    <div ref={rootRef} tabIndex={-1} inert={layerOpen} data-testid="removal-panel" data-window-drag className="flex min-h-0 flex-1 flex-col justify-center p-3 outline-none">
      <RemovalState removal={removal} />
    </div>
  );
}
