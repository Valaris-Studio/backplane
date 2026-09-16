// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RefObject } from "react";
import { ArrowLeft } from "lucide-react";
import { DangerZone } from "../callouts";
import { useDocumentationSectionTranslator } from "../section-localization";
import { useDocumentationCopy } from "../use-documentation-copy";
import { CopyButton } from "./CopyButton";
import { ParamsGrid } from "./ParamsGrid";
import { TerminalPromptBlock } from "./TerminalPromptBlock";
import { ToolAnnotationBadges } from "./ToolAnnotationBadges";
import { ToolKindBadge } from "./ToolKindBadge";
import { PROMPT_ROLE_LABELS } from "./roleLabels";
import { getServerSurface, getServerSurfaceTool } from "./data";
import type { PromptDoc, ResourceDoc, ToolDoc } from "./data";

export type ResolvedSelection =
  | { kind: "tool"; tool: ToolDoc }
  | { kind: "prompt"; prompt: PromptDoc }
  | { kind: "resource"; resource: ResourceDoc };

interface DetailPaneProps {
  resolved: ResolvedSelection;
  onSelectTool: (name: string) => void;
  onBack?: () => void;
  // Programmatic focus target for the mobile pane swap (tabIndex -1 container).
  focusRef?: RefObject<HTMLDivElement | null>;
}

function DetailHeading({ children }: { children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      <span aria-hidden className="h-3 w-[3px] shrink-0 bg-primary" />
      {children}
    </h3>
  );
}

function FullIdRow({ fullId }: { fullId: string }) {
  const { copy } = useDocumentationCopy();
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-muted)] px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem] text-foreground">
        {fullId}
      </code>
      <CopyButton text={fullId} label={copy.mcpReference.copyToolId} />
    </div>
  );
}

function ToolDetail({
  tool,
  onSelectTool,
}: {
  tool: ToolDoc;
  onSelectTool: (name: string) => void;
}) {
  const { copy } = useDocumentationCopy();
  const translate = useDocumentationSectionTranslator();
  const wireTool = getServerSurfaceTool(tool.name);
  const inDefaultHand =
    getServerSurface().default_toolset?.tools.includes(tool.name) ?? false;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2
          data-doc-technical
          className="font-mono text-xl font-semibold text-foreground"
        >
          {tool.name}
        </h2>
        <ToolKindBadge kind={tool.kind} />
        {wireTool ? (
          <ToolAnnotationBadges annotations={wireTool.annotations} />
        ) : null}
        {inDefaultHand ? (
          // Same badge shape as ToolAnnotationBadges; primary tokens so it
          // follows the theme instead of a fixed palette colour.
          <span
            data-testid="tool-in-default-hand"
            className="rounded-[var(--radius-sm)] border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-primary"
          >
            {copy.mcpReference.inDefaultHand}
          </span>
        ) : null}
      </div>
      <FullIdRow fullId={`mcp__valaris__${tool.name}`} />
      <p className="text-[0.95rem] leading-7 text-foreground/90">
        {translate(tool.description)}
      </p>

      {wireTool ? (
        <section className="space-y-2">
          <DetailHeading>{copy.mcpReference.wireDescriptionTitle}</DetailHeading>
          {/* Literal wire text the model receives — never translated. */}
          <pre
            data-doc-technical
            className="whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-muted)] px-3 py-2 font-mono text-[0.8rem] leading-6 text-muted-foreground"
          >
            {wireTool.description}
          </pre>
        </section>
      ) : null}

      <section className="space-y-2">
        <DetailHeading>{copy.mcpReference.parameters}</DetailHeading>
        <ParamsGrid params={tool.params} />
      </section>

      {tool.gotchas && tool.gotchas.length > 0 ? (
        <section className="space-y-2">
          <DetailHeading>{copy.mcpReference.gotchas}</DetailHeading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/85">
            {tool.gotchas.map((gotcha) => (
              <li key={gotcha}>{translate(gotcha)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {tool.danger ? (
        <DangerZone title={copy.mcpReference.dangerZone}>
          {translate(tool.danger)}
        </DangerZone>
      ) : null}

      <section className="space-y-2">
        <DetailHeading>{copy.mcpReference.examplePrompt}</DetailHeading>
        <TerminalPromptBlock prompt={tool.examplePrompt} />
      </section>

      {tool.related && tool.related.length > 0 ? (
        <section className="space-y-2">
          <DetailHeading>{copy.mcpReference.relatedTools}</DetailHeading>
          <div className="flex flex-wrap gap-1.5">
            {tool.related.map((name) => (
              <button
                key={name}
                type="button"
                data-doc-technical
                onClick={() => onSelectTool(name)}
                className="rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-surface-1)] px-2 py-1 font-mono text-[0.78rem] text-primary transition-colors hover:bg-[color:var(--color-accent)] hover:text-accent-foreground"
              >
                {name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PromptDetail({ prompt }: { prompt: PromptDoc }) {
  const { copy } = useDocumentationCopy();
  const translate = useDocumentationSectionTranslator();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2
          data-doc-technical
          className="font-mono text-xl font-semibold text-foreground"
        >
          {prompt.name}
        </h2>
        <span className="rounded-[var(--radius-sm)] border border-primary/50 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-primary">
          {translate(PROMPT_ROLE_LABELS[prompt.role])}
        </span>
      </div>
      <p className="text-[0.95rem] leading-7 text-foreground/90">
        {translate(prompt.description)}
      </p>
      <section className="space-y-2">
        <DetailHeading>{copy.mcpReference.parameters}</DetailHeading>
        <ParamsGrid params={prompt.params} />
      </section>
      <section className="space-y-2">
        <DetailHeading>{copy.mcpReference.examplePrompt}</DetailHeading>
        <TerminalPromptBlock prompt={prompt.examplePrompt} />
      </section>
    </div>
  );
}

function ResourceDetail({ resource }: { resource: ResourceDoc }) {
  const translate = useDocumentationSectionTranslator();
  return (
    <div className="space-y-5">
      <h2
        data-doc-technical
        className="break-all font-mono text-xl font-semibold text-foreground"
      >
        {resource.uri}
      </h2>
      <p className="text-[0.95rem] leading-7 text-foreground/90">
        {translate(resource.description)}
      </p>
    </div>
  );
}

export function DetailPane({
  resolved,
  onSelectTool,
  onBack,
  focusRef,
}: DetailPaneProps) {
  const { copy } = useDocumentationCopy();
  return (
    <div
      data-testid="mcp-detail"
      ref={focusRef}
      tabIndex={-1}
      className="min-w-0 space-y-4 outline-none"
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {copy.mcpReference.backToList}
        </button>
      ) : null}
      {resolved.kind === "tool" ? (
        <ToolDetail tool={resolved.tool} onSelectTool={onSelectTool} />
      ) : resolved.kind === "prompt" ? (
        <PromptDetail prompt={resolved.prompt} />
      ) : (
        <ResourceDetail resource={resolved.resource} />
      )}
    </div>
  );
}
