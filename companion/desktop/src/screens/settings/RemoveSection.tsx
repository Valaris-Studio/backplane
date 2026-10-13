// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { MouseEvent } from "react";

import { Button } from "../../components/Button";
import { Group, Row, RowText } from "../../components/Group";
import { SectionHead } from "../../components/SectionHead";
import { platformCopy } from "../../platform/copy";
import { confirmDialog } from "../../shell/layers";
import { removalFailureCopy } from "../../shell/removal-copy";
import { removeCompanion } from "../../stores/companion-service";
import { WaitingUploads } from "./WaitingUploads";

async function confirmRemove(event: MouseEvent<HTMLButtonElement>) {
  // The shell takes over from here: removing, then removed or removal_incomplete (companion-service).
  await confirmDialog({
    title: "Remove Companion?",
    body: (
      <>
        <p>This will:</p>
        <ul className="settings-consequences">
          <li>{`Disconnect ${platformCopy().thisDevice}`}</li>
          <li>Remove the hooks from Claude Code, Codex and Pi</li>
          <li>Stop the background service and delete local data</li>
          <li>Stop opening at login</li>
        </ul>
        <p>
          Sessions already uploaded stay in Backplane. <WaitingUploads />
        </p>
      </>
    ),
    confirmLabel: "Remove",
    returnFocusTo: event.currentTarget,
    onConfirm: async () => {
      const result = await removeCompanion();
      if (!result.ok) throw new Error(removalFailureCopy(result.failure, result.serverRevoked));
    },
  });
}

/** Signing out lives in the Backplane section; this is only for taking Companion off the device. */
export function RemoveSection() {
  return (
    <>
      <SectionHead title="Remove" />
      <Group label="Remove">
        <Row>
          <RowText title="Remove Companion" sub="Disconnects, removes every agent hook, and deletes local data." />
          <Button size="sm" variant="ghost-danger" onClick={(event) => void confirmRemove(event)}>
            Remove…
          </Button>
        </Row>
      </Group>
    </>
  );
}
