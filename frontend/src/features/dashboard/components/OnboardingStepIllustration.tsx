// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, GitBranch, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// Stylized mocks of what each step produces — drawn from tokens and divs, never
// binary screenshots, so they stay theme-aware and cost nothing to ship. Purely
// decorative: the frame is aria-hidden and the didactic text carries the
// meaning for assistive tech.
type StepIllustrationId =
  | "board"
  | "context"
  | "notes"
  | "members"
  | "channels"
  | "repos";

const BLOCK = "rounded-[var(--radius-sm)] bg-[color:var(--color-surface-1)]";
const LINE = "rounded-full bg-muted-foreground/25";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-step-illustration
      aria-hidden="true"
      className="flex h-[9rem] items-center justify-center overflow-hidden rounded-[calc(var(--radius-md))] border border-border/60 bg-[color:color-mix(in_oklab,var(--color-primary)_4%,var(--color-card))] p-4"
    >
      {children}
    </div>
  );
}

function BoardMock() {
  // Three typed columns with card-shaped blocks — the board's own rhythm.
  const columns = [3, 2, 1];
  return (
    <div className="flex h-full w-full max-w-[16rem] gap-2">
      {columns.map((cards, columnIndex) => (
        <div
          key={columnIndex}
          className="flex flex-1 flex-col gap-1.5 rounded-[var(--radius-sm)] border border-border/50 p-1.5"
        >
          <div className={cn(LINE, "h-1 w-2/3", columnIndex === 0 && "bg-primary/40")} />
          {Array.from({ length: cards }, (_, cardIndex) => (
            <div
              key={cardIndex}
              className={cn(
                BLOCK,
                "h-5 border border-border/50",
                columnIndex === 0 && cardIndex === 0 && "border-primary/40",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ContextMock() {
  return (
    <div className="w-full max-w-[13rem] rounded-[var(--radius-sm)] border border-border/60 bg-card/70 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Check className="h-3 w-3" />
        </div>
        <div className={cn(LINE, "h-1.5 w-1/2 bg-primary/35")} />
      </div>
      <div className="mt-3 space-y-1.5">
        {["w-full", "w-11/12", "w-4/5", "w-2/3"].map((width) => (
          <div key={width} className={cn(LINE, "h-1", width)} />
        ))}
      </div>
    </div>
  );
}

function NotesMock() {
  // Overlapping sticky notes, the middle one lifted as if pinned.
  const notes = ["-rotate-3", "z-10 scale-105", "rotate-3"];
  return (
    <div className="flex items-center gap-2">
      {notes.map((transform, index) => (
        <div
          key={index}
          className={cn(
            "h-16 w-14 rounded-[var(--radius-sm)] border p-2 transition-transform",
            transform,
            index === 1
              ? "border-primary/40 bg-[color:color-mix(in_oklab,var(--color-primary)_10%,var(--color-card))]"
              : "border-border/60 bg-card/80",
          )}
        >
          <div className="space-y-1">
            <div className={cn(LINE, "h-1 w-3/4")} />
            <div className={cn(LINE, "h-1 w-full")} />
            <div className={cn(LINE, "h-1 w-2/3")} />
          </div>
        </div>
      ))}
    </div>
  );
}

function MembersMock() {
  return (
    <div className="flex items-center">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full border-2 border-card bg-primary/15",
            index > 0 && "-ml-3",
          )}
        >
          <div className="h-5 w-5 rounded-full bg-primary/40" />
        </div>
      ))}
      <div className="-ml-3 flex h-11 w-11 items-center justify-center rounded-full border-2 border-dashed border-primary/40 bg-card text-primary">
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
}

function ChannelsMock() {
  // Alternating bubbles read as a conversation without any text.
  const bubbles = [
    { align: "self-start", width: "w-24", tinted: false },
    { align: "self-end", width: "w-20", tinted: true },
    { align: "self-start", width: "w-28", tinted: false },
  ];
  return (
    <div className="flex w-full max-w-[13rem] flex-col gap-2">
      {bubbles.map(({ align, width, tinted }, index) => (
        <div
          key={index}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[var(--radius-cap)] px-2.5",
            align,
            width,
            tinted
              ? "bg-primary/20"
              : "border border-border/60 bg-[color:var(--color-surface-1)]",
          )}
        >
          <div className={cn(LINE, "h-1 flex-1")} />
        </div>
      ))}
    </div>
  );
}

function ReposMock() {
  // A trunk of commit dots with one branch peeling off and merging back.
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary">
        <GitBranch className="h-5 w-5" />
      </div>
      <div className="relative h-16 w-32">
        <div className="absolute left-0 right-0 top-10 h-px bg-border" />
        <div className="absolute left-6 right-10 top-4 h-px bg-primary/40" />
        <div className="absolute left-6 top-4 h-6 w-px bg-primary/40" />
        <div className="absolute right-10 top-4 h-6 w-px bg-primary/40" />
        {[0, 10, 20, 30].map((offset, index) => (
          <div
            key={offset}
            className={cn(
              "absolute top-[2.25rem] h-2 w-2 rounded-full border border-card",
              index === 3 ? "bg-primary" : "bg-muted-foreground/40",
            )}
            style={{ left: `${offset * 0.25 + 0.25}rem` }}
          />
        ))}
        <div className="absolute left-[1.25rem] top-[0.75rem] h-2 w-2 rounded-full border border-card bg-primary/60" />
        <div className="absolute right-[2.25rem] top-[0.75rem] h-2 w-2 rounded-full border border-card bg-primary/60" />
      </div>
    </div>
  );
}

const MOCKS: Record<StepIllustrationId, () => React.JSX.Element> = {
  board: BoardMock,
  context: ContextMock,
  notes: NotesMock,
  members: MembersMock,
  channels: ChannelsMock,
  repos: ReposMock,
};

export function OnboardingStepIllustration({ id }: { id: StepIllustrationId }) {
  const Mock = MOCKS[id];
  return (
    <Frame>
      <Mock />
    </Frame>
  );
}
