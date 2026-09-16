// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A textarea that is exactly as tall as its content.
 *
 * The measurement is deliberately per-ELEMENT rather than per-list: reading
 * `scrollHeight` forces layout, and the Slots tab renders 58 rows, so a
 * tab-level effect sweeping every textarea would pay 58 reflows per keystroke.
 * Each textarea measures only itself, only when its own value changes.
 *
 * Resetting `height` to `auto` before the read is the non-obvious half:
 * `scrollHeight` never reports LESS than the height already applied, so
 * without the reset the box would ratchet upward and never shrink back.
 */
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  // Layout effect, not effect: the browser must not paint the un-sized box
  // between the value landing and the height being applied, or every keystroke
  // that adds a line flickers.
  useLayoutEffect(measure, [measure, value]);

  return ref;
}
