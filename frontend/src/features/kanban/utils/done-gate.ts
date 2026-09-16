// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolves the done merge gate the same way the backend does: a board's
 * `enforce_done_merge_gate` override wins outright when set (true = enforced
 * even if the workspace opted out, false = off even if the workspace enforces),
 * and only `null`/absent falls through to the workspace flag.
 *
 * Fail-closed on unknowns: an undefined workspace flag (query still loading or
 * errored) reads as NOT gated, so consumers never flash a requirement they
 * can't yet confirm.
 *
 * The structural repo-less exemption is NOT modelled here — it is supreme
 * server-side and each consumer applies it where it has the repo list.
 */
export function resolveDoneGate(
  boardOverride: boolean | null | undefined,
  workspaceEnforces: boolean | undefined,
): boolean {
  return boardOverride ?? workspaceEnforces === true;
}
