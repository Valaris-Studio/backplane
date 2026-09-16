// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { reducedMotionQuery } from "@/lib/animations";

export function useReducedMotion() {
  const getPreference = () => window.matchMedia(reducedMotionQuery).matches;
  const [reducedMotion, setReducedMotion] = useState(() => getPreference());

  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const handleChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}
