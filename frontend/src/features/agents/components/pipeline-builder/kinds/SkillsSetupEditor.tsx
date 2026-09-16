// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import type { KindEditorProps } from "./types";

// No params by contract (backend params_schema is {}): the step materializes
// whatever skills manifest rides the assignment bundle.
export function SkillsSetupEditor(_props: KindEditorProps<"skills_setup">) {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {t("pipelineBuilder.lifecycle.kinds.skills_setup.description")}
    </p>
  );
}
