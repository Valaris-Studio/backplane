// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Button } from "../../components/Button";
import { Icon, TrayGlyph } from "../../components/Icon";
import { platformCopy } from "../../platform/copy";
import { finishOnboarding } from "../../shell/navigation";
import { markOnboardingFinished, resetOnboarding } from "./onboarding-store";
import { OnboardingFrame, PromiseItem, Promises } from "./OnboardingFrame";

function finish() {
  markOnboardingFinished();
  resetOnboarding();
  finishOnboarding();
}

export function DoneStep() {
  return (
    <OnboardingFrame
      step="done"
      hero={
        <div className="ob-done-mark">
          <Icon name="check" />
        </div>
      }
      title="You’re set"
      lede={
        <>
          Capture runs in the background from now on. The{" "}
          <span className="ob-inline-tray">
            <TrayGlyph state="capturing" />
          </span>{" "}
          {`in the ${platformCopy().trayLocation} shows its status. A badge means something needs you.`}
        </>
      }
      actions={
        <Button variant="primary" size="lg" onClick={finish}>
          Done
        </Button>
      }
    >
      <Promises>
        <PromiseItem icon={<Icon name="pause" />} title="Pause">
          {platformCopy().pauseHowTo}
        </PromiseItem>
        <PromiseItem icon={<Icon name="sliders" />} title="Change what’s sent">
          Projects lets you set Metadata, Standard or Full per folder.
        </PromiseItem>
      </Promises>
    </OnboardingFrame>
  );
}
