// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The first-party emoji grid for a template's face (F9 Direction: no picker
// dependency, no remote font, no CDN). A curated set beats a full Unicode
// picker here — a loop template's identity lives in a narrow domain, and the
// free-text field beside the grid covers everything this list does not.
export const TEMPLATE_EMOJI = [
  "🔁", "🔄", "♾️", "🧭", "🎯", "🚀", "🛠️", "🔧",
  "⚙️", "🧪", "🔬", "🧬", "🩺", "🧹", "🧼", "📦",
  "📚", "📝", "📋", "🗂️", "🔍", "🕵️", "📊", "📈",
  "🗺️", "🧩", "🏗️", "🚧", "🛡️", "🔒", "🔑", "🚦",
  "⏱️", "📅", "🤖", "🧠", "👷", "🐝", "🐙", "🦉",
  "🌱", "🌊", "🔥", "⭐", "✨", "💡", "🎨", "🏁",
] as const;

/** Shown when a template has no emoji: an empty avatar reads as a bug. */
export const FALLBACK_EMOJI = "🌀";

/**
 * The first grapheme of `value`, or "" — an emoji is not one JS char.
 *
 * A family emoji is seven code points joined by ZWJs, so both `slice(0, 1)`
 * and `[...value][0]` would store a fragment that renders as a stray person.
 * `Intl.Segmenter` is in every target browser; the code-point fallback exists
 * only for a test environment that lacks it, and is still better than a UTF-16
 * slice because it never splits a surrogate pair.
 */
export function firstGrapheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    const [first] = segmenter.segment(trimmed);
    return first?.segment ?? "";
  }
  return [...trimmed][0] ?? "";
}
