// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Button } from "../../components/Button";
import { StatePanel } from "../../components/StatePanel";

/**
 * A command found no daemon behind the socket. There is no "start the
 * daemon" command in the bindings, so the retry repeats what failed; the
 * shell's own NotRunning gate takes over once the stream notices too.
 */
export function DaemonDownPanel({ onRetry, retrying = false }: { onRetry: () => void; retrying?: boolean }) {
  return (
    <StatePanel
      tone="error"
      icon="power"
      title="Companion isn't running"
      actions={
        <Button variant="primary" loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      }
    >
      The background service isn’t answering. It may still be starting.
    </StatePanel>
  );
}
