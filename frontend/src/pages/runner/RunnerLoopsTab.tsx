// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LoopTemplateLibrary } from "@/features/loop-templates/components/LoopTemplateLibrary";

// Runner Console → Loops tab. Sibling of the Pipeline tab, never merged with
// it: loops and pipelines are different runner features and the owner rule is
// that they stay visibly separate surfaces.
export function RunnerLoopsTab() {
  return <LoopTemplateLibrary />;
}
