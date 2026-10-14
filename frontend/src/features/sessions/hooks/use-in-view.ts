// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, type RefObject } from "react";

// Latches true the first time the element nears the viewport, so a row fetches
// its links once it is about to be seen and never again on scroll.
export function useInView(ref: RefObject<Element | null>, rootMargin = "200px"): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);

  return seen;
}
