// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { McpFlowIllustration } from "./McpFlowIllustration";

export function StepIntro({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4" data-testid="wizard-step-intro">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground">
          {t("mcpOnboarding.introHeading")}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("mcpOnboarding.introBody")}
        </p>
      </div>

      <McpFlowIllustration />

      <p className="text-sm font-medium text-foreground">
        {t("mcpOnboarding.introPromise")}
      </p>

      <DialogFooter>
        <Button onClick={onNext} data-testid="wizard-next">
          {t("mcpOnboarding.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}
