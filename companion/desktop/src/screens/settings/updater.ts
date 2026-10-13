// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type UpdateChannel, type UpdateCheck, type UpdateError, type UpdateFailed } from "../../ipc/bindings";

/** The updater rejects with UpdateError, which src/ipc/errors.ts (DaemonError-only) does not know. */
export type UpdateFailure = UpdateError | { kind: "unknown" };

export type UpdateResult<T> = { ok: true; value: T } | { ok: false; error: UpdateFailure };

const UPDATE_ERROR_KINDS: ReadonlySet<string> = new Set<UpdateError["kind"]>([
  "no_update",
  "busy",
  "check",
  "download",
  "signature",
  "capture",
  "keep_previous",
  "install",
  "settings",
  "not_bundled",
  "updates_unavailable_on_platform",
  "updates_not_configured",
]);

function toUpdateFailure(rejection: unknown): UpdateFailure {
  if (typeof rejection === "object" && rejection !== null && "kind" in rejection && typeof rejection.kind === "string" && UPDATE_ERROR_KINDS.has(rejection.kind)) {
    return rejection as UpdateError;
  }
  return { kind: "unknown" };
}

async function callUpdater<T>(invocation: () => Promise<T>): Promise<UpdateResult<T>> {
  try {
    return { ok: true, value: await invocation() };
  } catch (rejection) {
    return { ok: false, error: toUpdateFailure(rejection) };
  }
}

export const checkForUpdate = (): Promise<UpdateResult<UpdateCheck>> => callUpdater(() => commands.checkForUpdate());
export const installUpdate = (): Promise<UpdateResult<null>> => callUpdater(() => commands.installUpdate());
export const lastUpdateResult = (): Promise<UpdateResult<UpdateFailed | null>> => callUpdater(() => commands.lastUpdateResult());
export const updateChannel = (): Promise<UpdateResult<UpdateChannel>> => callUpdater(() => commands.updateChannelGet());
export const setUpdateChannel = (channel: UpdateChannel): Promise<UpdateResult<UpdateChannel>> =>
  callUpdater(() => commands.updateChannelSet(channel));
