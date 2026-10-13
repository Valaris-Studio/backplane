// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { validateDeviceName } from "../settings/copy";

// What the daemon's ValidDeviceName accepts: Go's unicode.IsPrint, i.e.
// letters, marks, numbers, punctuation, symbols and the ASCII space. This
// also refuses control and bidi characters that could disguise the name.
const UNPRINTABLE = /[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/u;

export type DeviceNameCheck = { ok: true; name: string | null } | { ok: false; problem: string };

/** The name to pair with; an empty field leaves the server's neutral default (null). */
export function checkDeviceName(draft: string): DeviceNameCheck {
  const name = draft.trim();
  if (name === "") return { ok: true, name: null };
  const problem = validateDeviceName(name) ?? (UNPRINTABLE.test(name) ? "Use letters, numbers, spaces and punctuation only." : null);
  return problem ? { ok: false, problem } : { ok: true, name };
}
