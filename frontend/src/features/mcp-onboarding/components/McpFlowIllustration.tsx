// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bot, Kanban, Wrench } from "lucide-react";

// Token-drawn, theme-aware, zero assets — the OnboardingStepIllustration house
// style, kept local because that component's id union is closed. Purely
// decorative: the frame is aria-hidden and the didactic copy beside it carries
// the meaning for assistive tech.
export function McpFlowIllustration() {
  const nodes = [
    { icon: Bot, key: "agent" },
    { icon: Wrench, key: "tools" },
    { icon: Kanban, key: "board" },
  ];

  return (
    <div
      aria-hidden="true"
      className="flex h-[7.5rem] items-center justify-center gap-3 overflow-hidden rounded-[var(--radius-md)] border border-border/60 bg-[color:color-mix(in_oklab,var(--color-primary)_4%,var(--color-card))] px-4"
    >
      {nodes.map(({ icon: Icon, key }, index) => (
        <div key={key} className="flex items-center gap-3">
          {index > 0 ? <Connector delayMs={(index - 1) * 900} /> : null}
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-cap)] border border-primary/25 bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <div className="h-1 w-9 rounded-full bg-muted-foreground/25" />
          </div>
        </div>
      ))}
    </div>
  );
}

// A dashed run with a travelling dot — reads as traffic without any text.
// The dot rides the connector-travel keyframe (agent → board direction); the
// second run is phase-offset by half a cycle so the hop reads as a relay, not
// a metronome. fill-mode backwards keeps the delayed dot hidden until its
// first cycle. Under reduced motion it parks at the midpoint instead.
function Connector({ delayMs }: { delayMs: number }) {
  return (
    <div className="relative h-px w-10 bg-[repeating-linear-gradient(90deg,var(--color-border)_0_4px,transparent_4px_8px)]">
      <div
        className="absolute -top-[0.1875rem] left-0 h-1.5 w-1.5 rounded-full bg-primary/60 [animation-fill-mode:backwards] motion-safe:animate-connector-travel motion-reduce:left-1/2 motion-reduce:-translate-x-1/2"
        style={{ animationDelay: `${delayMs}ms` }}
      />
    </div>
  );
}
