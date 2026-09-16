// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useState } from "react";

// The app shell is deliberately unbounded (`min-h-screen`): pages grow and the
// WINDOW scrolls (the TopBar's compact-on-scroll rides that). The board view
// instead wants viewport-fit — columns scroll internally and their headers stay
// pinned — which needs a real bounded height at the top of its flex chain.
// This hook pins the element's height to run FLUSH to the bottom screen edge:
//
//   height       = innerHeight − (document offset above the element)
//   marginBottom = −(sum of ancestor bottom paddings)
//
// The negative margin cancels the shell's bottom chrome (content wrapper py,
// main pb, shell p-4) so the taller box doesn't grow the document — otherwise
// the window gains exactly that much scroll and the headers ride off again.
// Ancestor paddings are summed from computed style — static values independent
// of content. (Deriving chrome from document height instead is a trap: the
// shell's min-h-screen pads the document with empty filler, which reads as
// "chrome" and freezes the element at whatever height it had when measured.)
// Re-measures on window resize and on <body> size changes (cost banner
// mounting, TopBar height transitions). A floor keeps the board usable on very
// short viewports — the window scrolls a little there instead, which is the
// lesser evil.
const MIN_HEIGHT_PX = 320;

export function useViewportBoundHeight<T extends HTMLElement>() {
  // Callback-ref via state, NOT useRef: the consumer (BoardLayout) renders a
  // loading skeleton first, so the measured div mounts on a LATER render. A
  // ref + empty-dep effect runs once against null and never engages; keying
  // the effect on the attached node re-runs it exactly when the div appears.
  const [node, setNode] = useState<T | null>(null);

  useLayoutEffect(() => {
    if (!node) return;

    function measure() {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const docTop = window.scrollY + rect.top;
      let chromeBelow = 0;
      for (let p = node.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        chromeBelow +=
          (parseFloat(style.paddingBottom) || 0) +
          (parseFloat(style.borderBottomWidth) || 0);
      }
      const next = Math.max(window.innerHeight - docTop, MIN_HEIGHT_PX);
      // Write-if-changed guards the ResizeObserver feedback loop: setting the
      // height resizes <body>, which re-fires the observer.
      if (Math.abs(next - rect.height) > 1) {
        node.style.height = `${next}px`;
        node.style.marginBottom = `-${chromeBelow}px`;
      }
    }

    measure();
    window.addEventListener("resize", measure);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(document.body);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [node]);

  return setNode;
}
