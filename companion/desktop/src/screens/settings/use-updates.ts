// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";

import type { UpdateChannel, UpdateFailed } from "../../ipc/bindings";
import { showToast } from "../../shell/layers";
import { installFailure, updateCheckFailure } from "./copy";
import { checkForUpdate, installUpdate, lastUpdateResult, setUpdateChannel, updateChannel } from "./updater";

export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "check_failed"; message: string }
  | { phase: "available"; version: string; installError: string | null }
  | { phase: "installing"; version: string };

export interface Updates {
  state: UpdatePhase;
  checkedAt: Date | null;
  /** null until the shell answers; may be a stored value this build doesn't know. */
  channel: string | null;
  rolledBack: UpdateFailed | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  changeChannel: (next: UpdateChannel) => Promise<void>;
}

const CHANNEL_COPY: Record<UpdateChannel, string> = {
  stable: "Stable channel.",
  beta: "Beta channel: updates arrive earlier and may be rougher.",
};

/** Lives on the Settings screen so the banners at the top and the Updates group share it. */
export function useUpdates(runningVersion: string): Updates {
  const [state, setState] = useState<UpdatePhase>({ phase: "idle" });
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [rolledBack, setRolledBack] = useState<UpdateFailed | null>(null);

  useEffect(() => {
    let current = true;
    void updateChannel().then((result) => {
      // Kept verbatim: an unknown stored channel is shown, never coerced to Stable.
      if (current && result.ok) setChannel(result.value as string);
    });
    void lastUpdateResult().then((result) => {
      if (current && result.ok) setRolledBack(result.value);
    });
    return () => {
      current = false;
    };
  }, []);

  const check = async () => {
    if (state.phase === "checking" || state.phase === "installing") return;
    setState({ phase: "checking" });
    const result = await checkForUpdate();
    if (!result.ok) {
      setState({ phase: "check_failed", message: updateCheckFailure(result.error) });
      return;
    }
    setCheckedAt(new Date());
    setState(result.value.available ? { phase: "available", version: result.value.version, installError: null } : { phase: "current" });
  };

  const install = async () => {
    if (state.phase !== "available") return;
    const version = state.version;
    setState({ phase: "installing", version });
    // On success the app relaunches into the new version, so only failures come back.
    const result = await installUpdate();
    if (result.ok) return;
    if (result.error.kind === "no_update") {
      setState({ phase: "check_failed", message: installFailure(result.error, runningVersion) });
      return;
    }
    setState({ phase: "available", version, installError: installFailure(result.error, runningVersion) });
  };

  const changeChannel = async (next: UpdateChannel) => {
    const previous = channel;
    setChannel(next);
    const result = await setUpdateChannel(next);
    if (result.ok) {
      setChannel(result.value);
      showToast(CHANNEL_COPY[result.value]);
      return;
    }
    setChannel(previous);
    showToast("Couldn’t change the update channel. Try again.", { tone: "error" });
  };

  return { state, checkedAt, channel, rolledBack, check, install, changeChannel };
}
