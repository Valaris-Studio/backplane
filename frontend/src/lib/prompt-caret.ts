// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type CaretInsertion = { next: string; caret: number };

/**
 * Splice `token` into `value` where the operator's caret is.
 *
 * `touched` is the caller's record of whether the field has ever been focused:
 * an untouched textarea reports selectionStart 0, so honouring it would push
 * every insertion in front of the text the operator already typed. Before the
 * first focus we append instead.
 *
 * Pure on purpose — the board dialog and the template manager both drive their
 * own controlled state, and this is the one place the caret arithmetic lives.
 */
export function insertAtCaret(
  el: Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd"> | null,
  value: string,
  token: string,
  touched: boolean,
): CaretInsertion {
  const hasCaret = touched && el != null;
  const start = hasCaret ? el.selectionStart : value.length;
  const end = hasCaret ? el.selectionEnd : value.length;
  return {
    next: value.slice(0, start) + token + value.slice(end),
    caret: start + token.length,
  };
}
