// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// RFC 8628 user code as the backend issues it: 8 consonants, shown XXXX-XXXX.
const USER_CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

/** The canonical `XXXX-XXXX` form of what a person typed, or null if it cannot be a code. */
export function normalizeUserCode(typed: string): string | null {
  const code = typed.replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE_ALPHABET.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}
