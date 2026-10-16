// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  Copy,
  FilePen,
  FileText,
  GitFork,
  Globe,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { LinkProvenance, SessionCallItem, WithheldField } from "@/types/agent-session";
import { useSessionCall } from "../api/use-sessions";
import { callError, callOutput, formatCallDuration, OUTPUT_DISPLAY_LIMIT } from "../utils/call-content";
import { usePromptsHidden } from "../hooks/use-hide-prompts";
import { formatBytes, formatClock } from "../utils/format";
import { presentArgs } from "../utils/presenter";
import { CallContentText } from "./PromptText";
import { WithheldChip } from "./WithheldChip";
import { WorkChip } from "./WorkChip";

type KindTone = "tool" | "file" | "work" | "error";

const TONE_COLOR: Record<KindTone, string> = {
  tool: "var(--color-kind-tool)",
  file: "var(--color-kind-file)",
  work: "var(--color-kind-work)",
  error: "var(--color-kind-error)",
};

const TOOL_ICONS: [RegExp, LucideIcon, KindTone][] = [
  [/^(edit|write|multi_?edit|apply_?patch|notebook_?edit|str_replace)/i, FilePen, "file"],
  [/^(bash|shell|exec|command|run)/i, SquareTerminal, "tool"],
  [/^(read|view|cat)/i, FileText, "tool"],
  [/^(grep|glob|ls|list|search|find|rg)/i, Search, "tool"],
  [/^(task|agent|spawn)/i, GitFork, "tool"],
  [/^web/i, Globe, "tool"],
];

function callVisual(item: SessionCallItem): { Icon: LucideIcon; tone: KindTone } {
  if (item.outcome === "failed") {
    const match = TOOL_ICONS.find(([pattern]) => pattern.test(item.name ?? ""));
    return { Icon: item.kind === "mcp" ? Plug : (match?.[1] ?? Wrench), tone: "error" };
  }
  if (item.kind === "mcp") return { Icon: Plug, tone: item.work_refs.length ? "work" : "tool" };
  const match = TOOL_ICONS.find(([pattern]) => pattern.test(item.name ?? ""));
  return match ? { Icon: match[1], tone: match[2] } : { Icon: Wrench, tone: "tool" };
}

export function callDisplayName(item: SessionCallItem): string {
  if (item.kind === "mcp" && item.mcp_server && item.mcp_tool) return `${item.mcp_server} · ${item.mcp_tool}`;
  return item.name ?? item.mcp_tool ?? "";
}

function withheldBytes(item: SessionCallItem, field: WithheldField): number | null | undefined {
  const entry = item.withheld.find((withheld) => withheld.field === field);
  return entry ? entry.bytes : undefined;
}

const ARGS_CLASSES = "min-w-0 truncate font-mono text-[0.82rem] text-muted-foreground";

function CallArguments({ toolName, args }: { toolName: string | null; args: string }) {
  const promptsHidden = usePromptsHidden();
  if (!promptsHidden) return <span className={ARGS_CLASSES}>{args}</span>;
  const { visible, hidden } = presentArgs(toolName, args);
  return (
    <span className={cn(ARGS_CLASSES, "inline-flex gap-[0.5ch]")}>
      {visible ? <span className="shrink-0">{visible}</span> : null}
      {hidden ? <CallContentText text={hidden} className="min-w-0 truncate" /> : null}
    </span>
  );
}

export function KindIcon({ Icon, tone }: { Icon: LucideIcon; tone: KindTone }) {
  return (
    <span
      aria-hidden
      className="grid size-[1.6rem] shrink-0 place-items-center rounded-[var(--radius-cap)]"
      style={{ color: TONE_COLOR[tone], backgroundColor: `color-mix(in oklab, ${TONE_COLOR[tone]} 12%, transparent)` }}
    >
      <Icon className="size-[0.9rem]" />
    </span>
  );
}

interface CallRowProps {
  slug: string;
  sessionId: string;
  item: SessionCallItem;
  evidenceProvenance?: LinkProvenance;
}

export function CallRow({ slug, sessionId, item, evidenceProvenance }: CallRowProps) {
  const { t } = useTranslation();
  const failed = item.outcome === "failed";
  const [expanded, setExpanded] = useState(failed && !evidenceProvenance);
  const panelId = useId();
  const { Icon, tone } = callVisual(item);
  const name = callDisplayName(item);
  const argumentsWithheld = withheldBytes(item, "arguments");
  const outputWithheld = withheldBytes(item, "output");

  return (
    <li data-call-row="">
      {evidenceProvenance ? <div className="mb-1.5 grid gap-0.5 text-[0.8rem] text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <time dateTime={item.started_at} className="tabular-nums">{formatClock(item.started_at)}</time>
          <span className="font-semibold">{t(`sessions.evidence.${evidenceProvenance}`)}</span>
        </p>
        <p>{t(`sessions.evidence.${evidenceProvenance}Hint`)}</p>
      </div> : null}
      <div
        className={cn(
          "-mx-2 grid grid-cols-[1.6rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-[var(--radius-cap)] px-2 py-1 text-[0.89rem] transition-colors duration-150 hover:bg-accent/75",
          failed && "bg-[color:color-mix(in_oklab,var(--color-error)_6%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--color-error)_10%,transparent)]",
        )}
      >
        <KindIcon Icon={Icon} tone={tone} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onClick={() => setExpanded((open) => !open)}
            className="flex min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-cap)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span data-call-name="" className="shrink-0 whitespace-nowrap font-bold text-foreground">
              {name}
            </span>
            {item.args_preview ? <CallArguments toolName={item.name} args={item.args_preview} /> : null}
          </button>
          {!item.args_preview && argumentsWithheld !== undefined ? (
            <WithheldChip
              label={
                argumentsWithheld === null
                  ? t("sessions.timeline.argsWithheld")
                  : t("sessions.timeline.argsWithheldSize", { size: formatBytes(argumentsWithheld) })
              }
            />
          ) : null}
          {item.work_refs.map((ref) => (
            <WorkChip key={`${ref.workspace_id}-${ref.entity_type}-${ref.entity_id}-${ref.relation}`} slug={slug} work={ref} className="shrink" />
          ))}
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap text-[0.8rem] text-muted-foreground">
          {/* Expanded, the panel states the output once; the row stays quiet. */}
          {expanded ? null : item.output === "withheld" ? (
            <WithheldChip
              label={
                outputWithheld != null
                  ? t("sessions.timeline.outputWithheldSize", { size: formatBytes(outputWithheld) })
                  : t("sessions.timeline.outputWithheld")
              }
              accessibleLabel={
                outputWithheld != null
                  ? t("sessions.timeline.outputWithheldLabelSize", { size: formatBytes(outputWithheld) })
                  : t("sessions.timeline.outputWithheldLabel")
              }
              className="max-md:hidden"
            />
          ) : item.output === "none" && item.outcome !== "running" ? (
            <span className="max-md:hidden">{t("sessions.timeline.noOutput")}</span>
          ) : null}
          {item.duration_ms !== null ? <span className="tabular-nums">{formatCallDuration(item.duration_ms)}</span> : null}
          <CallOutcome item={item} />
        </div>
      </div>
      {expanded ? <CallDetailPanel id={panelId} slug={slug} sessionId={sessionId} item={item} /> : null}
    </li>
  );
}

function CallOutcome({ item }: { item: SessionCallItem }) {
  const { t } = useTranslation();
  switch (item.outcome) {
    case "succeeded":
      return (
        <Check
          role="img"
          aria-label={t("sessions.timeline.outcome.succeeded")}
          className="size-3.5 text-[color:var(--color-success-foreground)]"
        />
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 font-bold text-[color:var(--color-error-ink)]">
          <AlertCircle aria-hidden className="size-3.5" />
          {item.exit_code !== null
            ? t("sessions.timeline.outcome.exit", { code: item.exit_code })
            : t("sessions.timeline.outcome.failed")}
        </span>
      );
    case "running":
      return <span className="font-medium">{t("sessions.timeline.outcome.running")}</span>;
    case "unknown":
      return <span className="font-medium italic">{t("sessions.timeline.outcome.unknown")}</span>;
    default:
      return null;
  }
}

interface CallDetailPanelProps {
  id: string;
  slug: string;
  sessionId: string;
  item: SessionCallItem;
}

function CallDetailPanel({ id, slug, sessionId, item }: CallDetailPanelProps) {
  const { t } = useTranslation();
  const detail = useSessionCall(slug, sessionId, item.key, true);
  const promptsHidden = usePromptsHidden();
  const [copied, setCopied] = useState(false);
  const events = detail.data?.events ?? [];
  const error = callError(events);
  const output = item.output === "sent" ? callOutput(events) : null;
  const shownOutput = output && output.length > OUTPUT_DISPLAY_LIMIT ? output.slice(0, OUTPUT_DISPLAY_LIMIT) : output;
  const outputWithheld = withheldBytes(item, "output");

  return (
    <div
      id={id}
      className="mb-2 ml-[2.1rem] mt-1 grid gap-2 rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-2)] px-3 py-2.5 text-[0.84rem]"
    >
      {detail.isPending ? (
        <p className="text-muted-foreground">{t("sessions.timeline.detail.loading")}</p>
      ) : detail.isError ? (
        <p className="text-muted-foreground">{t("sessions.timeline.detail.loadError")}</p>
      ) : null}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {error ? (
          <>
            <dt className="text-[0.78rem] font-semibold text-muted-foreground">{t("sessions.timeline.detail.error")}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono text-[0.8rem] text-[color:var(--color-error-ink)]">
              <CallContentText text={error} />
            </dd>
          </>
        ) : null}
        <dt className="text-[0.78rem] font-semibold text-muted-foreground">{t("sessions.timeline.detail.output")}</dt>
        <dd className="min-w-0">
          {item.output === "withheld" ? (
            <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <WithheldChip
                label={
                  outputWithheld != null
                    ? t("sessions.timeline.outputWithheldSize", { size: formatBytes(outputWithheld) })
                    : t("sessions.timeline.outputWithheld")
                }
              />
              {t("sessions.timeline.detail.outputStayed")}
            </span>
          ) : item.output === "none" ? (
            <span className="text-muted-foreground">{t("sessions.timeline.detail.noOutput")}</span>
          ) : shownOutput ? (
            <div className="grid gap-1.5">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-cap)] bg-card p-2 font-mono text-[0.8rem] leading-relaxed">
                <CallContentText text={shownOutput} />
              </pre>
              <div className="flex items-center gap-3">
                {/* Presenting, the output must not reach the clipboard either. */}
                {promptsHidden ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => setCopied(await copyTextToClipboard(output ?? ""))}
                >
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? t("sessions.timeline.detail.copied") : t("sessions.timeline.detail.copyOutput")}
                </Button>
                )}
                {shownOutput !== output ? (
                  <span className="text-[0.78rem] text-muted-foreground">{t("sessions.timeline.detail.truncated")}</span>
                ) : null}
              </div>
            </div>
          ) : null}
        </dd>
        {item.call_id ? (
          <>
            <dt className="text-[0.78rem] font-semibold text-muted-foreground">{t("sessions.timeline.detail.callId")}</dt>
            <dd className="truncate font-mono text-[0.8rem]">{item.call_id}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
