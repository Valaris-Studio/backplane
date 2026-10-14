// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type UninstallReport } from "../ipc/bindings";
import { createExternalStore } from "./external-store";

export type ServiceStart = { state: "idle" } | { state: "starting" } | { state: "failed"; reason: ServiceStartFailure };

export type ServiceStartFailure = "not_in_applications" | "not_bundled" | "failed";

const IDLE: ServiceStart = { state: "idle" };
const STARTING: ServiceStart = { state: "starting" };

export const serviceStartStore = createExternalStore<ServiceStart>(IDLE);

let autoStartAttempted = false;

function failureOf(rejection: unknown): ServiceStartFailure {
  const kind = typeof rejection === "object" && rejection !== null ? (rejection as { kind?: unknown }).kind : undefined;
  if (kind === "ephemeral_location" || kind === "not_in_applications") return "not_in_applications";
  if (kind === "not_bundled") return "not_bundled";
  return "failed";
}

/** Installs and starts the login service; the stream reconnects once the daemon listens. */
export async function startCompanionService(): Promise<void> {
  if (serviceStartStore.get().state === "starting" || removalUnderway()) return;
  serviceStartStore.set(STARTING);
  try {
    await commands.startCompanionService();
    serviceStartStore.set(IDLE);
  } catch (rejection) {
    serviceStartStore.set({ state: "failed", reason: failureOf(rejection) });
  }
}

/**
 * Once per app run: a fresh install has no service until onboarding, yet
 * pairing needs the daemon. Only from the trusted install location (/Applications
 * on macOS), so the login service never points at a Downloads or DMG copy.
 */
export async function autoStartCompanionServiceOnce(): Promise<void> {
  if (autoStartAttempted || removalUnderway()) return;
  autoStartAttempted = true;
  const inApplications = await commands.appLocation().then(
    (location) => location.in_applications,
    () => false,
  );
  if (inApplications) await startCompanionService();
}

/**
 * What `companion_uninstall` stopped at, as far as anyone can tell: a failed
 * step names what already ran; anything else is unconfirmed. The two refusals
 * come before any step runs, so nothing was removed.
 */
export type RemovalFailure = "hooks" | "service" | "purge" | "login_item" | "unconfirmed" | "not_in_applications" | "not_bundled";

/**
 * Remove Companion, in memory only: a relaunch starts over with the normal
 * rules. Anything but idle is terminal for this run. Removal stops the daemon
 * on purpose, so the shell must not treat that as "not running" and start it again.
 */
export type Removal =
  | { state: "idle" }
  | { state: "removing" }
  | { state: "removed"; serverRevoked: boolean }
  | { state: "removal_incomplete"; failure: RemovalFailure; serverRevoked?: boolean };

const NOT_REMOVING: Removal = { state: "idle" };
export const removalStore = createExternalStore<Removal>(NOT_REMOVING);

export function removalUnderway(): boolean {
  return removalStore.get().state !== "idle";
}

const FAILURE_FOR_STEP: Record<string, RemovalFailure> = {
  "agents uninstall": "hooks",
  "service uninstall": "service",
  "uninstall --purge": "purge",
};

function removalFailureOf(rejection: unknown): RemovalFailure {
  if (typeof rejection !== "object" || rejection === null) return "unconfirmed";
  const { kind, step } = rejection as { kind?: unknown; step?: unknown };
  if (kind === "not_in_applications" || kind === "ephemeral_location") return "not_in_applications";
  if (kind === "not_bundled") return "not_bundled";
  // Rust reports it only once every companion step has finished.
  if (kind === "login_item_failed") return "login_item";
  // Only a companion_failed step is known to be the one that failed; a protocol error may follow a step that ran.
  if (kind === "companion_failed" && typeof step === "string") return FAILURE_FOR_STEP[step] ?? "unconfirmed";
  return "unconfirmed";
}

const NOTHING_RAN: ReadonlySet<RemovalFailure> = new Set(["not_in_applications", "not_bundled"]);

/** `serverRevoked` only when every companion step finished (a login_item failure), so the server outcome is known. */
export type RemovalResult = { ok: true; report: UninstallReport } | { ok: false; failure: RemovalFailure; serverRevoked?: boolean };

function serverOutcomeOf(rejection: unknown): { serverRevoked?: boolean } {
  if (typeof rejection !== "object" || rejection === null) return {};
  const { kind, report } = rejection as { kind?: unknown; report?: { server_revoked?: unknown } };
  if (kind !== "login_item_failed" || typeof report?.server_revoked !== "boolean") return {};
  return { serverRevoked: report.server_revoked };
}

let runningRemoval: Promise<RemovalResult> | null = null;
// Bumped per companion_uninstall run: only the latest run's answer may set the state.
let latestRemovalAttempt = 0;

async function runRemoval(attempt: number): Promise<RemovalResult> {
  const settle = (next: Removal) => {
    if (attempt === latestRemovalAttempt) removalStore.set(next);
  };
  try {
    const report = await commands.companionUninstall();
    settle({ state: "removed", serverRevoked: report.server_revoked });
    return { ok: true, report };
  } catch (rejection) {
    const failure = removalFailureOf(rejection);
    const serverOutcome = serverOutcomeOf(rejection);
    settle(NOTHING_RAN.has(failure) ? NOT_REMOVING : { state: "removal_incomplete", failure, ...serverOutcome });
    return { ok: false, failure, ...serverOutcome };
  }
}

/**
 * Runs companion_uninstall; `removing` is set before the call, so nothing
 * restarts the service meanwhile. A call while one runs joins it.
 */
export function removeCompanion(): Promise<RemovalResult> {
  if (runningRemoval) return runningRemoval;
  latestRemovalAttempt += 1;
  removalStore.set({ state: "removing" });
  const run = runRemoval(latestRemovalAttempt).finally(() => {
    if (runningRemoval === run) runningRemoval = null;
  });
  runningRemoval = run;
  return run;
}

export function resetServiceStartForTests(): void {
  autoStartAttempted = false;
  serviceStartStore.set(IDLE);
  removalStore.set(NOT_REMOVING);
  runningRemoval = null;
  latestRemovalAttempt += 1;
}
