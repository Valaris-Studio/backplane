// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Anchor, Image as ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ShowcaseCardProps {
  id: string;
  name: string;
  concept: string;
  interaction: string;
  technicalNotes: string;
  whyItMatters: string;
  caption: string;
}

interface LabelledSectionProps {
  label: string;
  children: string;
}

function LabelledSection({ label, children }: LabelledSectionProps) {
  return (
    <div className="space-y-1.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-6 text-foreground">{children}</dd>
    </div>
  );
}

export function ShowcaseCard({
  id,
  name,
  concept,
  interaction,
  technicalNotes,
  whyItMatters,
  caption,
}: ShowcaseCardProps) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-24 space-y-5 rounded-[var(--radius-lg)] border border-border bg-[color:var(--color-surface-1)] p-[var(--card-padding)] shadow-soft",
      )}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Anchor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {name}
          </h2>
        </div>
        <Badge variant="outline">Not yet implemented</Badge>
      </header>

      <dl className="grid gap-4 md:grid-cols-2">
        <LabelledSection label="Concept">{concept}</LabelledSection>
        <LabelledSection label="Interaction">{interaction}</LabelledSection>
        <LabelledSection label="Technical Notes">{technicalNotes}</LabelledSection>
        <LabelledSection label="Why it matters">{whyItMatters}</LabelledSection>
      </dl>

      <div
        className={cn(
          "flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-muted-foreground/30 bg-muted/20 px-4 py-8 text-center",
        )}
        aria-label={`${name} placeholder slot`}
      >
        <ImageIcon className="h-6 w-6 text-muted-foreground/60" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Component slot — not yet implemented. See description above.
        </p>
      </div>

      <p className="text-sm italic text-muted-foreground">{caption}</p>
    </section>
  );
}
