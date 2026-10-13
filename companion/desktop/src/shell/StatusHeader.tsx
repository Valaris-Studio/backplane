// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { MouseEvent } from "react";

import { IconButton } from "../components/Button";
import { Icon, TrayGlyph } from "../components/Icon";
import { commands } from "../ipc/bindings";
import { callDaemon } from "../ipc/daemon";
import { platformCopy } from "../platform/copy";
import { attentionStore, statusStore } from "../stores/daemon-stream";
import { useStoreSelector } from "../stores/external-store";
import { useLiveSessionCount } from "../stores/sessions";
import { statusModel } from "./status-model";
import { showToast } from "./layers";
import { push } from "./navigation";

async function setPaused(paused: boolean) {
  const result = await callDaemon(paused ? commands.pause : commands.resume);
  if (result.ok) {
    showToast(paused ? `Capture paused on ${platformCopy().thisDevice}.` : "Capture resumed.");
  } else {
    showToast(paused ? "Couldn’t pause capture. Try again in a moment." : "Couldn’t resume capture. Try again in a moment.", { tone: "error" });
  }
}

function openSettings(event: MouseEvent<HTMLButtonElement>) {
  push("settings", { returnFocusTo: event.currentTarget });
}

/** Subscribes to the status, attention and session count itself, so status ticks re-render only the header. */
export function StatusHeader() {
  const status = useStoreSelector(statusStore, (current) => current);
  const attention = useStoreSelector(attentionStore, (items) => items);
  const liveSessions = useLiveSessionCount();
  if (!status) return null;
  const model = statusModel({ status, attention, liveSessions, deviceName: status.account?.device_name ?? null });
  return (
    <div className="bp-status" data-testid="status-header" data-tone={model.tone}>
      <span className="bp-status-glyph">
        {model.glyph.kind === "tray" ? <TrayGlyph state={model.glyph.state} /> : <Icon name={model.glyph.name} />}
      </span>
      <div className="bp-status-text">
        {/* Only the title is live: it changes rarely, while the sub-line ticks with every session. */}
        <div className="bp-status-title" role="status" aria-live="polite">
          {model.title}
        </div>
        <div className="bp-status-sub">{model.sub}</div>
      </div>
      {model.pauseControl === "resume" ? (
        <IconButton icon="play" label="Resume capture" onClick={() => void setPaused(false)} />
      ) : model.pauseControl === "pause" || model.pauseControl === "pause-disabled" ? (
        <IconButton
          icon="pause"
          label="Pause capture"
          tooltip={model.pauseHint}
          disabled={model.pauseControl === "pause-disabled"}
          onClick={() => void setPaused(true)}
        />
      ) : null}
      <IconButton icon="gear" label="Settings" data-focus-key="settings" onClick={openSettings} />
    </div>
  );
}
