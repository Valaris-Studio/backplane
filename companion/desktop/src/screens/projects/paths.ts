// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Control, format (bidi overrides, zero-width space), line/paragraph separators and lone surrogates:
// none belongs in a shown name, and several can make one read as something else. ZWNJ and ZWJ
// (U+200C, U+200D) stay: Persian, Indic scripts and emoji sequences need them.
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]|(?![\u200C\u200D])\p{Cf}/gu;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_OR_CONTROL, "");
}

export function folderName(path: string): string {
  const clean = stripInvisible(path);
  const segments = clean.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? clean;
}
