// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RichTextRenderer } from "@/components/shared/RichTextRenderer";
import type { NoteRevisionDetail, NoteRevisionSnapshot } from "../api/note-history-types";
import { canonicalStructure, compareRichBlocks, retainedText, richBlocks, richDocument, storedAttributes, unsupportedRichTypes, type RichNode } from "../utils/note-rich-comparison";

const METADATA_FIELDS = ["title", "pinned", "card_id", "kind", "failure_class", "findings", "source_execution_id"] as const;

function MetadataValue({ value }: { value: unknown }) {
  const { t } = useTranslation();
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">{t("notes.comparison.none")}</span>;
  if (Array.isArray(value)) return <ul className="space-y-1">{value.map((item, index) => <li key={index}><MetadataValue value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="space-y-1">{Object.entries(value).map(([key, item]) => <div key={key}>
    <dt className="text-muted-foreground">{t(`notes.comparison.findingFields.${key}`, { defaultValue: key })}</dt>
    <dd>{key === "severity" && typeof item === "string" ? t(`notes.findings.severity.${item}`, { defaultValue: item }) : <MetadataValue value={item} />}</dd>
  </div>)}</dl>;
  return <span>{String(value)}</span>;
}

function SnapshotMetadata({ snapshot, fields }: { snapshot: NoteRevisionSnapshot; fields: readonly (keyof NoteRevisionSnapshot)[] }) {
  const { t } = useTranslation();
  return <dl className="space-y-3 text-sm">{fields.map((field) => <div key={field}>
    <dt className="text-xs text-muted-foreground">{t(`notes.comparison.fields.${field}`)}</dt>
    <dd className="mt-0.5 break-words [overflow-wrap:anywhere]">{field === "pinned"
      ? t(snapshot.pinned ? "notes.comparison.pinned" : "notes.comparison.unpinned")
      : <MetadataValue value={snapshot[field]} />}</dd>
  </div>)}</dl>;
}

function RichSnapshot({ blocks, identity }: { blocks: RichNode[]; identity: string }) {
  const { t } = useTranslation();
  const { attributes, links } = useMemo(() => storedAttributes(blocks), [blocks]);
  const unsupported = useMemo(() => unsupportedRichTypes(blocks), [blocks]);
  return <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
    {unsupported.length ? <>
      <p className="text-xs text-muted-foreground">{t("notes.comparison.unsupportedStructure")}</p>
      <ul className="text-xs">{unsupported.map((type) => <li key={type}>{type}</li>)}</ul>
      <div className="space-y-3 text-sm">{blocks.map((block, index) => <p key={index} className="whitespace-pre-wrap">{retainedText(block)}</p>)}</div>
    </> : <RichTextRenderer key={identity} content={richDocument(blocks)} className="min-w-0 [&_table]:max-w-full [&_pre]:overflow-x-auto" />}
    {links.length > 0 && <div className="space-y-1 border-t border-border/50 pt-2 text-xs">
      <p className="font-medium text-muted-foreground">{t("notes.comparison.linkDestinations")}</p>
      <ul>{links.map((link) => <li key={link} className="break-all">{link}</li>)}</ul>
    </div>}
    {attributes.length > 0 && <details className="text-xs">
      <summary className="cursor-pointer py-2 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("notes.comparison.attributes")}</summary>
      <dl className="space-y-2">{attributes.map((attribute, index) => <div key={index}>
        <dt className="text-muted-foreground">{attribute.name}</dt><dd className="break-words">{attribute.value}</dd>
      </div>)}</dl>
    </details>}
  </div>;
}

function UnrenderableSnapshot({ content }: { content: string }) {
  const { t } = useTranslation();
  let stored: unknown = content;
  try { stored = JSON.parse(content); } catch { /* Preserve non-JSON source as escaped text. */ }
  return <div className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]">
    <p className="text-muted-foreground">{t("notes.comparison.unsupportedStructure")}</p>
    <details>
      <summary className="cursor-pointer py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("notes.comparison.attributes")}</summary>
      <MetadataValue value={stored} />
    </details>
  </div>;
}

function SnapshotPair({ before, after, beforeIdentity, afterIdentity }: {
  before: RichNode[]; after: RichNode[]; beforeIdentity: string; afterIdentity: string;
}) {
  const { t } = useTranslation();
  return <div className="grid min-w-0 gap-5 md:grid-cols-2">
    <section className="min-w-0 space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{t("notes.comparison.before")}</h4>
      <RichSnapshot blocks={before} identity={beforeIdentity} />
    </section>
    <section className="min-w-0 space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{t("notes.comparison.after")}</h4>
      <RichSnapshot blocks={after} identity={afterIdentity} />
    </section>
  </div>;
}

export function NoteComparison({ before, after, identity }: {
  before?: NoteRevisionDetail; after: NoteRevisionDetail; identity: string;
}) {
  const { t } = useTranslation();
  const beforeBlocks = useMemo(() => richBlocks(before?.snapshot.content ?? ""), [before?.snapshot.content]);
  const afterBlocks = useMemo(() => richBlocks(after.snapshot.content), [after.snapshot.content]);
  const changes = useMemo(() => before && beforeBlocks && afterBlocks ? compareRichBlocks(beforeBlocks, afterBlocks) : [], [before, beforeBlocks, afterBlocks]);
  const beforeIdentity = `${identity}/${before?.revision}/${before?.revision_digest}`;
  const afterIdentity = `${identity}/${after.revision}/${after.revision_digest}`;
  const structuresEqual = beforeBlocks !== null && afterBlocks !== null && changes?.every((change) => change.kind === "unchanged");
  const changedFields = before ? METADATA_FIELDS.filter((field) => canonicalStructure(before.snapshot[field]) !== canonicalStructure(after.snapshot[field])) : ["title"] as const;
  const unchangedFields = METADATA_FIELDS.filter((field) => !changedFields.some((changed) => changed === field));

  return <div className="min-w-0 space-y-6">
    <div className="grid min-w-0 gap-5 md:grid-cols-2">
      {before && <section className="min-w-0 space-y-3">
        <h3 className="font-medium">{t("notes.comparison.before")} · {t("notes.history.revision", { revision: before.revision })}</h3>
        <SnapshotMetadata snapshot={before.snapshot} fields={changedFields} />
      </section>}
      <section className="min-w-0 space-y-3">
        <h3 className="font-medium">{before && `${t("notes.comparison.after")} · `}{t("notes.history.revision", { revision: after.revision })}</h3>
        <SnapshotMetadata snapshot={after.snapshot} fields={changedFields} />
      </section>
    </div>
    {unchangedFields.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer py-2 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("notes.comparison.unchangedMetadata")}</summary>
      <SnapshotMetadata snapshot={after.snapshot} fields={unchangedFields} />
    </details>}
    {!before ? <>
      {after.capture_kind !== "baseline" && <p className="text-sm text-muted-foreground">{t("notes.comparison.noPrevious")}</p>}
      {afterBlocks ? <RichSnapshot blocks={afterBlocks} identity={afterIdentity} /> : <UnrenderableSnapshot content={after.snapshot.content} />}
    </> : <div className="space-y-5 border-t border-border/70 pt-5">
      {structuresEqual && <p className="text-sm text-muted-foreground">{t(before.content_sha256 !== after.content_sha256
        ? "notes.comparison.storedChanged" : "notes.comparison.contentUnchanged")}</p>}
      {!beforeBlocks || !afterBlocks ? <div className="grid min-w-0 gap-5 md:grid-cols-2">
        <section className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{t("notes.comparison.before")}</h4>
          {beforeBlocks ? <RichSnapshot blocks={beforeBlocks} identity={beforeIdentity} /> : <UnrenderableSnapshot content={before.snapshot.content} />}
        </section>
        <section className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{t("notes.comparison.after")}</h4>
          {afterBlocks ? <RichSnapshot blocks={afterBlocks} identity={afterIdentity} /> : <UnrenderableSnapshot content={after.snapshot.content} />}
        </section>
      </div> : changes === null ? <>
        <p className="text-sm text-muted-foreground">{t("notes.comparison.alignmentUnavailable")}</p>
        <SnapshotPair before={beforeBlocks} after={afterBlocks} beforeIdentity={beforeIdentity} afterIdentity={afterIdentity} />
      </> : changes.map((change, index) => change.kind === "unchanged" ? <details key={index} className="border-b border-border/50 pb-3">
        <summary className="cursor-pointer py-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("notes.comparison.unchanged", { count: change.after.length })}
        </summary>
        <RichSnapshot blocks={change.after} identity={`${afterIdentity}/unchanged/${index}`} />
      </details> : <section key={index} className="space-y-3">
        <h3 className="text-sm font-medium">{t(`notes.comparison.${change.kind}`)}</h3>
        <SnapshotPair before={change.before} after={change.after} beforeIdentity={`${beforeIdentity}/${index}`} afterIdentity={`${afterIdentity}/${index}`} />
      </section>)}
    </div>}
  </div>;
}
