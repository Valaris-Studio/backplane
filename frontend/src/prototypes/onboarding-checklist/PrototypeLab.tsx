// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DashboardContext } from "./DashboardContext";
import { usePrototypeChecklist } from "./model";
import { TimelineExperience } from "./timeline/TimelineExperience";
import { ESSENTIAL_META } from "./timeline/model";

export function PrototypeLab() {
  const state = usePrototypeChecklist();

  return (
    <DashboardContext variantName={ESSENTIAL_META.name} hypothesis={ESSENTIAL_META.hypothesis}>
      <TimelineExperience {...state} />
    </DashboardContext>
  );
}
