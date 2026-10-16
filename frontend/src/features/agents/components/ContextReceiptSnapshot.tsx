// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowUpRight, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EntityLink } from "@/components/shared/EntityLink";
import type {
  ContextDispatch,
  ContextExclusion,
  ContextManifest,
  ContextReceipt,
  ContextRecord,
  ContextSource,
  ContextSourceInclusion,
} from "@/features/agents/api/agents";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatAbsolute } from "@/lib/date-format";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const SHORT_ID_LENGTH = 8;

const PROMPT_BODY_CLASS =
  "max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs";
const DIGEST_CLASS = "break-all select-all font-mono text-xs text-foreground";
const BOARD_DEFINITION_KIND = "board_definition";

// Server enums are open-ended: anything missing from these maps is rendered
// verbatim as code, never folded into a known meaning.
const ADMISSION_COUNT_OUTCOMES = new Set(["partial", "excluded"]);
const INCLUSION_ROW_KEYS = new Map([
  ["exact", "executions.receipts.inclusionExact"],
  ["exact_block_not_observed", "executions.receipts.inclusionNotObserved"],
  ["empty", "executions.receipts.inclusionEmpty"],
]);
const EXCLUSION_REASON_KEYS = new Map([
  ["raw_body_limit", "executions.receipts.reasonRawBodyLimit"],
  ["fetch_budget", "executions.receipts.reasonFetchBudget"],
  ["record_too_large", "executions.receipts.reasonRecordTooLarge"],
  ["source_budget", "executions.receipts.reasonSourceBudget"],
  ["total_budget", "executions.receipts.reasonTotalBudget"],
  ["structure_depth_limit", "executions.receipts.reasonStructureDepthLimit"],
  ["structure_node_limit", "executions.receipts.reasonStructureNodeLimit"],
]);

function useByteLabel() {
  const { t } = useTranslation();
  return (count: number) =>
    t("executions.receipts.bytes", { count, formatted: formatNumber(count) });
}

async function copyRetained(text: string, successMessage: string) {
  if (await copyTextToClipboard(text)) toast.success(successMessage);
}

function DisclosureButton({
  expanded,
  controls,
  onToggle,
  className,
  children,
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "flex min-h-9 min-w-0 items-start gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] py-1.5 text-left text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <Chevron aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      {children}
    </button>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-foreground">{children}</h2>;
}

export function ContextReceiptSnapshot({
  slug,
  receipt,
}: {
  slug: string;
  receipt: ContextReceipt;
}) {
  const { t } = useTranslation();
  const byteLabel = useByteLabel();
  const [systemExpanded, setSystemExpanded] = useState(false);
  const systemRegionId = useId();
  const hasSystemPrompt = receipt.system_prompt.length > 0;

  return (
    <div className="space-y-6">
      {/* What was selected reads first: the retained prompt can run to
          hundreds of lines and would otherwise bury the explanation. */}
      <SelectedContext
        slug={slug}
        manifest={receipt.context_manifest}
        dispatch={receipt.dispatch ?? null}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-3">
            <SectionHeading>{t("executions.receipts.promptHeading")}</SectionHeading>
            <span className="text-xs tabular-nums text-muted-foreground">
              {byteLabel(receipt.prompt_bytes)}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              copyRetained(receipt.input_prompt, t("executions.prompt.copied"))
            }
          >
            <Copy aria-hidden />
            {t("executions.receipts.copyPrompt")}
          </Button>
        </div>
        <pre data-testid="execution-prompt-body" className={PROMPT_BODY_CLASS}>
          {receipt.input_prompt}
        </pre>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <DisclosureButton
            expanded={systemExpanded}
            controls={systemRegionId}
            onToggle={() => setSystemExpanded((open) => !open)}
            className="font-semibold text-foreground"
          >
            <span>{t("executions.receipts.systemPrompt")}</span>
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {byteLabel(receipt.system_prompt_bytes)}
            </span>
          </DisclosureButton>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasSystemPrompt}
            onClick={() =>
              copyRetained(receipt.system_prompt, t("executions.receipts.systemCopied"))
            }
          >
            <Copy aria-hidden />
            {t("executions.receipts.copySystemPrompt")}
          </Button>
        </div>
        <div id={systemRegionId} hidden={!systemExpanded}>
          {hasSystemPrompt ? (
            <pre className={PROMPT_BODY_CLASS}>{receipt.system_prompt}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("executions.receipts.noSystemPrompt")}
            </p>
          )}
        </div>
      </section>

      <ReceiptEvidence receipt={receipt} />
    </div>
  );
}

function InertCode({ value }: { value: string }) {
  return <code className="break-all font-mono">{value}</code>;
}

function SelectedContext({
  slug,
  manifest,
  dispatch,
}: {
  slug: string;
  manifest: ContextManifest;
  dispatch: ContextDispatch | null;
}) {
  const { t } = useTranslation();
  const { sources, diagnostics } = manifest;
  // Joined by source_index: the server does not promise array alignment.
  const inclusionBySource = new Map(
    (dispatch?.source_inclusions ?? []).map((inclusion) => [inclusion.source_index, inclusion]),
  );
  const exclusionsBySource = new Map<number, ContextExclusion[]>();
  for (const entry of diagnostics?.entries ?? []) {
    const sourceEntries = exclusionsBySource.get(entry.source_index) ?? [];
    sourceEntries.push(entry);
    exclusionsBySource.set(entry.source_index, sourceEntries);
  }
  const excludedTotal = diagnostics?.excluded_count ?? 0;
  return (
    <section className="space-y-2">
      <SectionHeading>{t("executions.receipts.selectedContext")}</SectionHeading>
      <p className="text-xs text-muted-foreground">
        {t("executions.receipts.selectedContextHint")}
      </p>
      {excludedTotal > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("executions.receipts.candidatesLeftOut", { count: excludedTotal })}
        </p>
      ) : null}
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("executions.receipts.noSources")}</p>
      ) : (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {sources.map((source) => (
            <SourceRow
              key={`${source.source_index}:${source.alias}`}
              slug={slug}
              source={source}
              inclusion={dispatch ? inclusionBySource.get(source.source_index) : undefined}
              exclusions={exclusionsBySource.get(source.source_index) ?? []}
              displayOrder={source.source_index + 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function useAdmissionFacts(source: ContextSource): ReactNode[] {
  const { t } = useTranslation();
  const coverageLabel =
    source.coverage === "record_traced"
      ? t("executions.receipts.occurrences", { count: source.records.length })
      : t("executions.receipts.sourceSnapshot");
  const admission = source.admission;
  if (!admission) return [coverageLabel];

  const facts: ReactNode[] = [];
  if (ADMISSION_COUNT_OUTCOMES.has(admission.outcome)) {
    facts.push(
      t("executions.receipts.admittedOf", {
        admitted: admission.admitted_count,
        candidates: admission.candidate_count,
      }),
    );
  } else if (admission.outcome === "empty") {
    facts.push(t("executions.receipts.nothingMatched"));
  } else if (admission.outcome === "complete") {
    facts.push(coverageLabel);
  } else {
    facts.push(coverageLabel, <InertCode value={admission.outcome} />);
  }
  if (admission.has_more_candidates && admission.candidate_limit != null) {
    facts.push(t("executions.receipts.moreNotesMatched", { count: admission.candidate_limit }));
  }
  return facts;
}

function SourceRow({
  slug,
  source,
  inclusion,
  exclusions,
  displayOrder,
}: {
  slug: string;
  source: ContextSource;
  inclusion: ContextSourceInclusion | undefined;
  exclusions: ContextExclusion[];
  displayOrder: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const admissionFacts = useAdmissionFacts(source);
  // A dispatch receipt's joined inclusion is authoritative: schema-1 manifests
  // carry no admission, yet the dispatch still records which sources were required.
  const isRequired = inclusion ? inclusion.required : source.admission?.required === true;
  const facts: ReactNode[] = [<span className="font-mono">{source.kind}</span>];
  if (isRequired) facts.push(t("executions.receipts.required"));
  facts.push(...admissionFacts);
  if (inclusion) {
    const inclusionKey = INCLUSION_ROW_KEYS.get(inclusion.outcome);
    facts.push(inclusionKey ? t(inclusionKey) : <InertCode value={inclusion.outcome} />);
  }
  facts.push(
    <span className="tabular-nums">
      {t("executions.receipts.renderedBytes", {
        count: source.rendered_bytes,
        formatted: formatNumber(source.rendered_bytes),
      })}
    </span>,
  );

  return (
    <li className="py-1">
      <DisclosureButton
        expanded={expanded}
        controls={regionId}
        onToggle={() => setExpanded((open) => !open)}
        className="w-full"
      >
        <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{displayOrder}</span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium text-foreground">{source.alias}</span>
          <span className="block text-xs text-muted-foreground">
            {facts.map((fact, index) => (
              <Fragment key={index}>
                {index > 0 ? " · " : null}
                {fact}
              </Fragment>
            ))}
          </span>
        </span>
      </DisclosureButton>
      <div id={regionId} hidden={!expanded} className="space-y-2 pb-3 pl-11 pr-2">
        {expanded ? (
          <SourceDetails
            slug={slug}
            source={source}
            inclusion={inclusion}
            exclusions={exclusions}
          />
        ) : null}
      </div>
    </li>
  );
}

function SourceDetails({
  slug,
  source,
  inclusion,
  exclusions,
}: {
  slug: string;
  source: ContextSource;
  inclusion: ContextSourceInclusion | undefined;
  exclusions: ContextExclusion[];
}) {
  const { t } = useTranslation();
  const hasFilter = Object.keys(source.filter).length > 0;
  const admission = source.admission;
  const leftOutTotal = admission ? admission.excluded_count : exclusions.length;
  return (
    <>
      {hasFilter ? (
        <p className="text-xs text-muted-foreground">
          {t("executions.receipts.filter")}{" "}
          <code className="break-all font-mono text-foreground">
            {JSON.stringify(source.filter)}
          </code>
        </p>
      ) : null}
      {admission?.outcome === "excluded" ? (
        <p className="text-sm text-muted-foreground">{t("executions.receipts.allLeftOut")}</p>
      ) : admission?.outcome === "empty" ? (
        <p className="text-sm text-muted-foreground">
          {t("executions.receipts.nothingMatchedSource")}
        </p>
      ) : source.coverage !== "record_traced" ? (
        <p className="text-sm text-muted-foreground">{t("executions.receipts.sourceOnly")}</p>
      ) : source.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("executions.receipts.noRecords")}</p>
      ) : (
        <ol className="space-y-2">
          {source.records.map((record) => (
            <RecordOccurrence
              key={`${record.record_index}:${record.note_id}`}
              slug={slug}
              record={record}
            />
          ))}
        </ol>
      )}
      {admission?.has_more_candidates && admission.candidate_limit != null ? (
        <p className="text-xs text-muted-foreground">
          {t("executions.receipts.windowFull", { limit: admission.candidate_limit })}
        </p>
      ) : null}
      {inclusion ? <InclusionDetail inclusion={inclusion} /> : null}
      {leftOutTotal > 0 || exclusions.length > 0 ? (
        <LeftOut source={source} exclusions={exclusions} total={leftOutTotal} />
      ) : null}
    </>
  );
}

function InclusionDetail({ inclusion }: { inclusion: ContextSourceInclusion }) {
  const { t } = useTranslation();
  let detail: string | null = null;
  if (inclusion.outcome === "exact" && inclusion.contribution_bytes != null) {
    detail = t("executions.receipts.foundVerbatimTimes", {
      count: inclusion.spans.length,
      formatted: formatNumber(inclusion.contribution_bytes),
    });
  } else if (inclusion.outcome === "exact_block_not_observed") {
    detail = t("executions.receipts.contributionUnknown");
  } else if (inclusion.outcome === "empty") {
    detail = t("executions.receipts.renderedNothingDetail");
  }
  return detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null;
}

// Excluded candidates are never linked: the receipt holds no board for them,
// and their content was not part of this prompt.
function LeftOut({
  source,
  exclusions,
  total,
}: {
  source: ContextSource;
  exclusions: ContextExclusion[];
  total: number;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <div className="space-y-1.5 pt-1">
      <h3 id={headingId} className="text-xs font-semibold text-foreground">
        {t("executions.receipts.leftOutHeading", { total })}
      </h3>
      {exclusions.length > 0 ? (
        <ul aria-labelledby={headingId} className="space-y-2">
          {exclusions.map((entry, index) => (
            <ExclusionEntry key={`${entry.candidate_index}:${index}`} source={source} entry={entry} />
          ))}
        </ul>
      ) : null}
      {exclusions.length < total ? (
        <p className="text-xs text-muted-foreground">
          {t("executions.receipts.leftOutBounded", { shown: exclusions.length, total })}
        </p>
      ) : null}
    </div>
  );
}

function ExclusionEntry({ source, entry }: { source: ContextSource; entry: ContextExclusion }) {
  const { t } = useTranslation();
  const isBoardDefinition =
    source.kind === BOARD_DEFINITION_KIND && entry.kind === BOARD_DEFINITION_KIND;
  const label =
    entry.title ||
    t(isBoardDefinition ? "executions.receipts.boardDefinition" : "executions.receipts.sourceBlock");
  const reasonKey = EXCLUSION_REASON_KEYS.get(entry.reason);
  const facts: ReactNode[] = [
    <span>{reasonKey ? t(reasonKey) : <InertCode value={entry.reason} />}</span>,
    <span className="font-mono">{entry.kind}</span>,
  ];
  if (entry.raw_body_bytes != null) {
    facts.push(
      <span className="tabular-nums">
        {t("executions.receipts.rawBytes", {
          count: entry.raw_body_bytes,
          formatted: formatNumber(entry.raw_body_bytes),
        })}
      </span>,
    );
  }
  if (entry.rendered_bytes != null) {
    facts.push(
      <span className="tabular-nums">
        {t("executions.receipts.renderedBytes", {
          count: entry.rendered_bytes,
          formatted: formatNumber(entry.rendered_bytes),
        })}
      </span>,
    );
  }
  if (entry.note_id) {
    facts.push(
      <span className="font-mono">
        {t("executions.receipts.noteId", { id: entry.note_id.slice(0, SHORT_ID_LENGTH) })}
      </span>,
    );
  }
  // The flex gap only separates visually; the space text nodes keep the facts
  // apart in textContent, copied text and screen-reader output.
  return (
    <li className="text-sm">
      <span className="block break-words font-medium text-foreground">{label}</span>{" "}
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {facts.map((fact, index) => (
          <Fragment key={index}>
            {index > 0 ? " " : null}
            {fact}
          </Fragment>
        ))}
      </div>
    </li>
  );
}

function RecordOccurrence({ slug, record }: { slug: string; record: ContextRecord }) {
  const { t } = useTranslation();
  return (
    <li className="text-sm">
      <EntityLink
        type="note"
        id={record.note_id}
        slug={slug}
        boardId={record.board_id ?? undefined}
        className="inline-flex max-w-full items-baseline gap-1 break-words font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 break-words">{record.title}</span>
        <ArrowUpRight aria-hidden className="h-3.5 w-3.5 shrink-0 self-center" />
        <span className="sr-only">{t("executions.receipts.openCurrentNote")}</span>
      </EntityLink>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span className="font-mono">{record.kind}</span>
        <span>
          {t("executions.receipts.noteUpdated", { time: formatAbsolute(record.updated_at) })}
        </span>
        <span className="tabular-nums">
          {t("executions.receipts.renderedBytes", {
            count: record.rendered_bytes,
            formatted: formatNumber(record.rendered_bytes),
          })}
        </span>
        <span className="font-mono">
          {t("executions.receipts.noteId", { id: record.note_id.slice(0, SHORT_ID_LENGTH) })}
        </span>
      </div>
    </li>
  );
}

function EvidenceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={DIGEST_CLASS}>{value}</dd>
    </div>
  );
}

function ReceiptEvidence({ receipt }: { receipt: ContextReceipt }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  return (
    <section>
      <DisclosureButton
        expanded={expanded}
        controls={regionId}
        onToggle={() => setExpanded((open) => !open)}
        className="font-semibold text-foreground"
      >
        {t("executions.receipts.evidence")}
      </DisclosureButton>
      {/* Full digests stay out of the DOM until asked for: a default view must
          not invite comparing identities by eye. */}
      <div id={regionId} hidden={!expanded} className="space-y-4 pl-6 pt-2">
        {expanded ? <EvidenceDetails receipt={receipt} /> : null}
      </div>
    </section>
  );
}

function EvidenceDetails({ receipt }: { receipt: ContextReceipt }) {
  const { t } = useTranslation();
  const manifest = receipt.context_manifest;
  return (
    <>
      <dl className="grid gap-3">
        <EvidenceItem
          label={t("executions.receipts.contextRevision")}
          value={receipt.context_revision}
        />
        <EvidenceItem label={t("executions.receipts.promptDigest")} value={receipt.prompt_sha256} />
        <EvidenceItem
          label={t("executions.receipts.systemPromptDigest")}
          value={receipt.system_prompt_sha256}
        />
        <EvidenceItem
          label={t("executions.receipts.manifestVersion")}
          value={t("executions.receipts.manifestVersionValue", {
            schema: manifest.schema_version,
            renderer: manifest.renderer_version,
          })}
        />
        <EvidenceItem
          label={t("executions.receipts.clientRequestId")}
          value={receipt.client_request_id}
        />
      </dl>
      {manifest.sources.map((source) => (
        <div
          key={`${source.source_index}:${source.alias}`}
          className="space-y-2 border-t border-border/60 pt-3"
        >
          <p className="break-words text-xs font-semibold text-foreground">
            {t("executions.receipts.sourceEvidenceHeading", {
              order: source.source_index + 1,
              alias: source.alias,
            })}
          </p>
          <dl className="grid gap-3">
            <EvidenceItem
              label={t("executions.receipts.sourceDigest")}
              value={source.rendered_sha256}
            />
          </dl>
          {source.records.map((record) => (
            <div key={`${record.record_index}:${record.note_id}`} className="grid gap-2">
              <p className="break-words text-xs text-muted-foreground">
                {t("executions.receipts.recordEvidenceHeading", {
                  order: record.record_index + 1,
                  title: record.title,
                  id: record.note_id,
                })}
              </p>
              <dl className="grid gap-2">
                <EvidenceItem
                  label={t("executions.receipts.recordRevisionDigest")}
                  value={record.revision_sha256}
                />
                <EvidenceItem
                  label={t("executions.receipts.recordRenderedDigest")}
                  value={record.rendered_sha256}
                />
              </dl>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export function ContextReceiptSnapshotSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SectionHeading>{t("executions.receipts.promptHeading")}</SectionHeading>
        <Button variant="outline" size="sm" disabled>
          <Copy aria-hidden />
          {t("executions.receipts.copyPrompt")}
        </Button>
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
