// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { PrivacyLevel } from "../../components/privacy-levels";
import type { DiscoveredProject, PairingTicket } from "../../ipc/bindings";
import type { ViewSwapKind } from "../../motion/variants";
import { createExternalStore, useStoreSelector } from "../../stores/external-store";
import { ONBOARDING_FINISHED_KEY } from "./constants";

export const ONBOARDING_STEPS = ["welcome", "server", "code", "agents", "projects", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** What the code card shows; `failed` carries its own message. */
export type CodeState =
  | { kind: "waiting" }
  | { kind: "offline" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "failed"; title: string; body: string };

export interface PendingPairing {
  ticket: PairingTicket;
  endpoint: string;
  /** The name the user confirmed, reused for a new code; null leaves the neutral default. */
  deviceName: string | null;
  /** When the ticket arrived (epoch ms), so the meter drains over the ticket's real lifetime. */
  issuedAt: number;
  codeState: CodeState;
}

/**
 * In-memory only, and module-scoped so it outlives the screen: the shell
 * unmounts onboarding while the daemon is unreachable, and the popover's
 * webview persists between openings. Nothing here is persisted; the step is
 * re-derived from daemon state (see effectiveStep).
 */
interface OnboardingState {
  /** Where the user navigated; null until they move, so the derived default applies. */
  chosenStep: OnboardingStep | null;
  pairing: PendingPairing | null;
  /** The daemon said connected (a pairing poll, already_connected) before a status caught up. */
  connectedByDaemon: boolean;
  transition: ViewSwapKind;
  /** A replacement code just arrived; its code group takes focus once. */
  focusNewCode: boolean;
  /**
   * The pair_start attempt still waiting for its answer. Cleared by any
   * navigation, so a view reused mid-transition never inherits a busy
   * Continue from an abandoned attempt.
   */
  startingAttempt: number | null;
  /** The Projects step's state, kept here so a daemon drop (which unmounts onboarding) loses nothing. */
  projects: ProjectsProgress;
  /**
   * The Device name field as the user left it, so a remounted server step keeps it: null while
   * untouched (a late suggestion still fills it), "" when deliberately cleared (stays empty).
   */
  deviceNameDraft: string | null;
}

export type ProjectOutcome = { kind: "bound"; level: PrivacyLevel } | { kind: "skipped" };

export interface ProjectsProgress {
  /** null until the owner picks one: the default then follows what the Backplane offers. */
  defaultLevel: PrivacyLevel | null;
  /** The rows as first loaded: bound repositories leave `discovered`, but their rows stay. */
  rows: readonly DiscoveredProject[] | null;
  outcomes: Readonly<Record<string, ProjectOutcome>>;
}

const NO_PROJECT_PROGRESS: ProjectsProgress = { defaultLevel: null, rows: null, outcomes: {} };

const INITIAL: OnboardingState = {
  chosenStep: null,
  pairing: null,
  connectedByDaemon: false,
  transition: "none",
  focusNewCode: false,
  startingAttempt: null,
  projects: NO_PROJECT_PROGRESS,
  deviceNameDraft: null,
};

/**
 * Bumped by every pair_start and by every navigation away from pairing, so a
 * pair_start answer that lands after Back (or after a newer attempt) is
 * dropped and its orphaned ticket cancelled (pairing-actions.ts).
 */
let pairingAttempt = 0;

export function nextPairingAttempt(): number {
  pairingAttempt += 1;
  return pairingAttempt;
}

export function isCurrentPairingAttempt(attempt: number): boolean {
  return attempt === pairingAttempt;
}

// Whether a connected status has been seen since onboarding (re)started; see observeConnectedStatus.
let sawConnectedStatus = false;

// Whether the daemon has answered pair_current since onboarding (re)started; it is asked until it does.
type PendingPairingCheck = "unasked" | "asking" | "answered";
let pendingPairingCheck: PendingPairingCheck = "unasked";

/** Claims the pair_current question; false while it is already asked or answered. */
export function claimPendingPairingCheck(): boolean {
  if (pendingPairingCheck !== "unasked") return false;
  pendingPairingCheck = "asking";
  return true;
}

export function settlePendingPairingCheck(answered: boolean): void {
  if (pendingPairingCheck === "asking") pendingPairingCheck = answered ? "answered" : "unasked";
}

export const onboardingStore = createExternalStore<OnboardingState>(INITIAL);

const SETUP_STEPS: readonly OnboardingStep[] = ["agents", "projects", "done"];
const PAIRING_STEPS: readonly OnboardingStep[] = ["welcome", "server"];

export function effectiveStep(state: OnboardingState, connected: boolean, finishedBefore: boolean): OnboardingStep {
  if (connected || state.connectedByDaemon) {
    return state.chosenStep && SETUP_STEPS.includes(state.chosenStep) ? state.chosenStep : "agents";
  }
  if (state.pairing) return "code";
  if (state.chosenStep && PAIRING_STEPS.includes(state.chosenStep)) return state.chosenStep;
  // A Mac that finished once and got disconnected already knows the promises.
  return finishedBefore ? "server" : "welcome";
}

export function useOnboardingState(): OnboardingState {
  return useStoreSelector(onboardingStore, (state) => state);
}

export function goToStep(step: OnboardingStep, transition: ViewSwapKind): void {
  nextPairingAttempt();
  onboardingStore.set({ ...onboardingStore.get(), chosenStep: step, transition, startingAttempt: null });
}

/** Starts a pair_start attempt and marks it as the one Continue waits on. */
export function startPairingAttempt(): number {
  const attempt = nextPairingAttempt();
  onboardingStore.set({ ...onboardingStore.get(), startingAttempt: attempt });
  return attempt;
}

export function settlePairingAttempt(attempt: number): void {
  const current = onboardingStore.get();
  if (current.startingAttempt === attempt) onboardingStore.set({ ...current, startingAttempt: null });
}

export function setDeviceNameDraft(draft: string): void {
  onboardingStore.set({ ...onboardingStore.get(), deviceNameDraft: draft });
}

export function updateProjects(change: (progress: ProjectsProgress) => ProjectsProgress): void {
  const current = onboardingStore.get();
  onboardingStore.set({ ...current, projects: change(current.projects) });
}

/** The daemon's ticket has no issue time today; use one if it ever carries it, else "now". */
function issuedAtOf(ticket: PairingTicket): number {
  const issuedAt = Date.parse((ticket as PairingTicket & { issued_at?: unknown }).issued_at as string);
  return Number.isFinite(issuedAt) ? issuedAt : Date.now();
}

export function beginPairing(ticket: PairingTicket, endpoint: string, deviceName: string | null = null): void {
  const pairing: PendingPairing = { ticket, endpoint, deviceName, issuedAt: issuedAtOf(ticket), codeState: { kind: "waiting" } };
  const current = onboardingStore.get();
  const replacing = current.pairing !== null;
  onboardingStore.set({ ...current, pairing, chosenStep: "code", transition: replacing ? "fade" : "push", focusNewCode: replacing, startingAttempt: null });
}

export function consumeFocusNewCode(): boolean {
  const current = onboardingStore.get();
  if (!current.focusNewCode) return false;
  onboardingStore.set({ ...current, focusNewCode: false });
  return true;
}

export function setCodeState(pairingId: string, codeState: CodeState): void {
  const current = onboardingStore.get();
  if (current.pairing?.ticket.pairing_id !== pairingId) return;
  onboardingStore.set({ ...current, pairing: { ...current.pairing, codeState } });
}

export function abandonPairing(): void {
  nextPairingAttempt();
  onboardingStore.set({ ...onboardingStore.get(), pairing: null, chosenStep: "server", transition: "pop", startingAttempt: null });
}

export function markConnected(): void {
  onboardingStore.set({ ...onboardingStore.get(), pairing: null, connectedByDaemon: true, chosenStep: "agents", transition: "push", startingAttempt: null });
}

export function resetOnboarding(): void {
  nextPairingAttempt();
  sawConnectedStatus = false;
  pendingPairingCheck = "unasked";
  onboardingStore.set(INITIAL);
}

/**
 * connectedByDaemon bridges the gap until a connected status arrives. Once
 * one has, a later `connected: false` means the Mac was disconnected or
 * revoked mid-setup: start over from pairing instead of staying on setup steps
 * the daemon can no longer serve.
 */
export function observeConnectedStatus(connected: boolean): void {
  if (connected) {
    sawConnectedStatus = true;
    return;
  }
  if (!sawConnectedStatus) return;
  sawConnectedStatus = false;
  nextPairingAttempt();
  onboardingStore.set({ ...INITIAL, transition: "pop" });
}

export function resetOnboardingForTests(): void {
  resetOnboarding();
}

// Storage can be missing or throw (private mode, blocked site data); onboarding must still work.
export function readOnboardingFinished(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_FINISHED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingFinished(): void {
  try {
    localStorage.setItem(ONBOARDING_FINISHED_KEY, "1");
  } catch {
    // Only costs a repeat of the welcome after a later disconnect.
  }
}

export const STEP_NUMBER: Record<OnboardingStep, number> = { welcome: 1, server: 2, code: 3, agents: 4, projects: 5, done: 5 };
export const STEP_COUNT = 5;
