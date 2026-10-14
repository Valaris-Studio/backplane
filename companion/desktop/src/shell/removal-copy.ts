// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { platformCopy } from "../platform/copy";
import type { RemovalFailure } from "../stores/companion-service";

// Each sentence claims only what the failed step implies; the companion's own text is never shown.
const REMOVAL_FAILURE_COPY: Record<Exclude<RemovalFailure, "not_in_applications">, string> = {
  hooks: "Companion couldn’t remove every agent hook, so removal stopped there. Try again.",
  service: "The agent hooks were removed, but the background service couldn’t be stopped. Try again.",
  purge: "The agent hooks and the background service were removed, but disconnecting and deleting local data may not have finished. Try again.",
  login_item: "Everything else was removed, but Backplane Companion is still set to open at login. Try again.",
  unconfirmed: "We couldn’t confirm what finished. Try again.",
  not_bundled: "This copy of the app is incomplete. Reinstall Backplane Companion.",
};

export function serverNotReachedCopy(): string {
  return `Backplane couldn’t be reached, so remove ${platformCopy().thisDevice} from your devices there too.`;
}

export function removalFailureSentence(failure: RemovalFailure): string {
  return failure === "not_in_applications" ? platformCopy().installFirstBeforeRemoval : REMOVAL_FAILURE_COPY[failure];
}

export function removalFailureCopy(failure: RemovalFailure, serverRevoked?: boolean): string {
  const failureCopy = removalFailureSentence(failure);
  return serverRevoked === false ? `${failureCopy} ${serverNotReachedCopy()}` : failureCopy;
}
