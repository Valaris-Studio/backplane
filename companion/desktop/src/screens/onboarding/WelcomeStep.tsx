// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Button } from "../../components/Button";
import { AppIcon, Icon } from "../../components/Icon";
import { platformCopy } from "../../platform/copy";
import { goToStep } from "./onboarding-store";
import { OnboardingFrame, PromiseItem, Promises } from "./OnboardingFrame";

export function WelcomeStep() {
  return (
    <OnboardingFrame
      step="welcome"
      hero={<AppIcon size={72} className="ob-hero" />}
      title="See which sessions worked on which card"
      lede="The Companion notices Claude Code, Codex and Pi sessions in your projects and adds them to the matching Backplane board, with tokens and cost."
      actions={
        <Button variant="primary" size="lg" onClick={() => goToStep("server", "push")}>
          Get started
        </Button>
      }
    >
      <Promises>
        <PromiseItem icon={<Icon name="shield" />} title="Only folders you bind">
          {`Everything else stays on ${platformCopy().thisDevice}. Nothing is sent from a folder you haven’t connected to a board.`}
        </PromiseItem>
        <PromiseItem icon={<Icon name="sliders" />} title="You choose what’s sent">
          Per project. Metadata sends activity only. Standard, the default, adds your prompts and commands. Full adds tool output and the agent’s replies.
        </PromiseItem>
        <PromiseItem icon={<Icon name="pause" />} title="Pause any time">
          {platformCopy().pauseAnyTime}
        </PromiseItem>
      </Promises>
    </OnboardingFrame>
  );
}
