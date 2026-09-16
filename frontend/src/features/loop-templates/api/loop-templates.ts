// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

// Mirrors backend/app/schemas/loop_template.py. Kept as a hand-written mirror
// rather than generated types because the manager reads a small, stable subset
// and the backend owns the authoritative shape.

/**
 * The template's stored, human-authored identity.
 *
 * The prose sections are OPTIONAL by design: a freshly duplicated template
 * has an emoji and a name and nothing else, and the profile page hides what
 * the author has not written rather than showing blank headings.
 */
export interface LoopTemplateProfile {
  emoji?: string;
  tagline?: string;
  tags?: string[];
  what_i_do?: string[];
  when_to_use?: string;
  when_not_to_use?: string;
  needs_from_board?: string;
  needs_from_runner?: string;
  how_i_end?: string;
  how_i_learn?: string;
}

/**
 * One catalog row, as the Library reads it.
 *
 * The listing is deliberately a SUPERSET (service `_p0_compat`): it also
 * inlines `description`/`system_prompt`/`loop_prompt`/`tools` for the shipped
 * board dialog, which applies a template straight from the listing. The
 * manager never reads those — it fetches content from `GET /{ref}` — so they
 * are typed on the dialog's own `LoopTemplate`, not here. Omitting them keeps
 * the Library honest about the Direction "summaries only, no full prompts".
 */
export interface LoopTemplateSummary {
  id: string;
  source: "system" | "workspace";
  name: string;
  version: number;
  is_system: boolean;
  is_draft: boolean;
  has_slots: boolean;
  profile: LoopTemplateProfile;
  boards_using: number;
  last_used_at: string | null;
  updated_at: string | null;
  draft_updated_at?: string | null;
  has_unpublished_changes?: boolean;
}

export interface LoopTemplateCatalog {
  templates: LoopTemplateSummary[];
  // The runner's Go-template vocabulary AS THE SERVER KNOWS IT. Relayed, never
  // restated in the frontend, so a runner that gains a var needs no UI change.
  meta: { runner_vars: string[] };
}

export interface LoopTemplateDetail {
  id: string;
  slug: string;
  source: "system" | "workspace";
  name: string;
  version: number;
  is_system: boolean;
  is_draft: boolean;
  profile: LoopTemplateProfile;
  content: Record<string, unknown>;
  lineage: Record<string, unknown> | null;
  updated_at: string | null;
  draft_updated_at?: string | null;
  has_unpublished_changes?: boolean;
}

/**
 * The DERIVED half of the profile — aggregated from stamped executions
 * (`AgentExecution.prompt_slug`), never stored on the template row, so it
 * cannot drift and survives detach/rebind/upgrade.
 */
export interface LoopTemplateTrackRecord {
  iterations: number;
  spent_usd: number;
  duration_seconds_total: number;
  last_used_at: string | null;
  boards: { board_id: string; iterations: number; spent_usd: number }[];
  outcomes: Record<string, number>;
  // Named rather than left in `outcomes` because "the loop ended itself" is
  // the run-quality signal the profile leads with.
  self_terminations: number;
}

export interface LoopTemplateVersion {
  version: number;
  published_at: string;
  note?: string | null;
}

// Mirrors LoopTemplateProfileRead: stored identity + derived track record +
// the knobs/tools/slots/contract an operator has to satisfy to run it.
export interface LoopTemplateProfileRead {
  id: string;
  slug: string;
  source: "system" | "workspace";
  name: string;
  version: number;
  is_system: boolean;
  profile: LoopTemplateProfile;
  boards_using: number;
  versions: LoopTemplateVersion[];
  rails_defaults: Record<string, unknown>;
  tools: string[];
  slots: Record<string, unknown>[];
  setup_contract: Record<string, unknown>;
  track_record: LoopTemplateTrackRecord;
}

// The backend's own sort vocabulary (router pattern
// ^(name|updated_at|boards_using)$). Anything outside it is a 422.
export const LOOP_TEMPLATE_SORTS = [
  "name",
  "updated_at",
  "boards_using",
] as const;
export type LoopTemplateSort = (typeof LOOP_TEMPLATE_SORTS)[number];

export interface LoopTemplateListParams {
  q?: string;
  sort?: LoopTemplateSort;
}

function templatesUrl(slug: string) {
  return `/workspaces/${slug}/loop-templates`;
}

export async function fetchLoopTemplates(
  slug: string,
  params: LoopTemplateListParams = {},
): Promise<LoopTemplateCatalog> {
  // An empty q is omitted rather than sent blank — `?q=` would make the
  // backend run a LIKE '%%' scan on every first paint.
  const query: Record<string, string> = {};
  if (params.q) query.q = params.q;
  if (params.sort) query.sort = params.sort;

  const { data } = await api.get<LoopTemplateCatalog>(templatesUrl(slug), {
    params: query,
  });
  return data;
}

export async function fetchLoopTemplate(
  slug: string,
  ref: string,
  options: { draft?: boolean } = {},
): Promise<LoopTemplateDetail> {
  const { data } = await api.get<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}`,
    { params: options.draft ? { draft: true } : {} },
  );
  return data;
}

export async function fetchLoopTemplateProfile(
  slug: string,
  ref: string,
): Promise<LoopTemplateProfileRead> {
  const { data } = await api.get<LoopTemplateProfileRead>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/profile`,
  );
  return data;
}

/** Published history, newest first (the backend's own ordering). */
export async function fetchLoopTemplateVersions(
  slug: string,
  ref: string,
): Promise<LoopTemplateVersion[]> {
  const { data } = await api.get<LoopTemplateVersion[]>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/versions`,
  );
  return data;
}

/**
 * Stage a published snapshot as the draft. It does NOT republish, so bound
 * boards keep running the version they are bound to until someone publishes.
 */
export async function restoreLoopTemplateVersion(
  slug: string,
  ref: string,
  version: number,
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/versions/${version}/restore`,
    {},
  );
  return data;
}

export async function createLoopTemplate(
  slug: string,
  body: {
    slug: string;
    name: string;
    profile?: LoopTemplateProfile;
    // Backend `LoopTemplateCreate` has always accepted a whole content body;
    // only the manager's "new empty draft" path left it out. "Save as
    // template…" seeds prompts, slots, rails and tools in the SAME create, so
    // a half-built template never exists on the wire.
    content?: Record<string, unknown>;
  },
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(templatesUrl(slug), body);
  return data;
}

/**
 * One repo-fact leak warning (`app/services/loop_template_lint.py`).
 *
 * Deliberately NOT `LoopTemplateFinding`: a lint hint never blocks, carries a
 * 1-based `line` instead of a dotted `field`, and has no character offset —
 * callers that want to select the text recover it with `findMatchRange`.
 */
export interface LoopTemplateLeakFinding {
  code: string;
  match: string;
  line: number;
  hint: string;
}

/** Lint the DRAFT half. Always 200; findings are hints, never errors. */
export async function lintLoopTemplate(
  slug: string,
  ref: string,
): Promise<LoopTemplateLeakFinding[]> {
  const { data } = await api.post<{ findings: LoopTemplateLeakFinding[] }>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/lint`,
    {},
  );
  return data.findings;
}

/**
 * The result of `POST /loop-templates/import`, dry-run or committed.
 *
 * There is no created/updated/skipped counter object: an import touches
 * exactly one template, so the backend reports a single `action` verb plus
 * `diff_summary` — the names of the prompt fields that differ from the
 * existing draft, empty on a create.
 *
 * The two finding lists are different shapes on purpose: `findings` blocks a
 * commit (validator, dotted `field`), `leak_findings` never blocks (lint).
 * `template_id` is null on a dry run and set only once the row exists.
 */
export interface LoopTemplateImportResult {
  schema_version: number;
  dry_run: boolean;
  action: "created" | "updated";
  slug: string;
  findings: LoopTemplateFinding[];
  diff_summary: string[];
  leak_findings: LoopTemplateLeakFinding[];
  template_id: string | null;
}

/**
 * Import a bundle envelope. The whole envelope is the JSON request body —
 * the route takes `dict = Body(...)`, not a multipart upload, so the caller
 * parses the file and posts its contents.
 *
 * `dryRun` is explicit at this layer because the destructive half must be
 * opted into by the UI, not inherited from a default.
 */
export async function importLoopTemplate(
  slug: string,
  bundle: unknown,
  { dryRun }: { dryRun: boolean },
): Promise<LoopTemplateImportResult> {
  const { data } = await api.post<LoopTemplateImportResult>(
    `${templatesUrl(slug)}/import`,
    bundle,
    { params: { dry_run: dryRun } },
  );
  return data;
}

/**
 * The autosave payload. Every field optional (backend `LoopTemplateUpdate`).
 *
 * `expected_updated_at` is the DRAFT's optimistic lock and its counterpart is
 * `draft_updated_at` on the read shapes — never their `updated_at`, which
 * tracks the whole row on a different clock. A mismatch is a 409 `stale_draft`.
 */
export interface LoopTemplateUpdateBody {
  name?: string;
  profile?: LoopTemplateProfile;
  content?: Record<string, unknown>;
  expected_updated_at?: string | null;
}

export async function updateLoopTemplate(
  slug: string,
  ref: string,
  body: LoopTemplateUpdateBody,
): Promise<LoopTemplateDetail> {
  const { data } = await api.patch<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}`,
    body,
  );
  return data;
}

/**
 * One publish-blocking finding, as `validate_template` emits it.
 *
 * `field` is a dotted path rooted at the template content — `system_prompt`,
 * `loop_prompt`, `slots.<NAME>`, `rails_defaults.<key>` — which is what lets
 * the publish dialog deep-link the tab that owns the offending field.
 */
export interface LoopTemplateFinding {
  code: string;
  field: string;
  message: string;
  value?: unknown;
}

export async function publishLoopTemplate(
  slug: string,
  ref: string,
  body: { expected_version?: number | null; note?: string | null },
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/publish`,
    body,
  );
  return data;
}

/**
 * The rendered runner view, as `LoopTemplatePreviewRead` serves it.
 *
 * FLAT by design (backend p2-03): `loop_prompt_with_tools_manifest` is the
 * string the AGENT actually reads — the runner appends its tools manifest after
 * rendering — while `loop_prompt` is what the author wrote. `used_values` says
 * where each value came from, which is what lets the panel label an autofilled
 * slot with its source.
 */
export interface LoopTemplatePreview {
  template: { ref: string; version: number | null };
  system_prompt: string;
  loop_prompt: string;
  loop_prompt_with_tools_manifest: string;
  tools: string[];
  rails: Record<string, unknown>;
  findings: LoopTemplateFinding[];
  missing_required: string[];
  used_values: Record<string, { value?: unknown; source?: string }>;
}

/**
 * Preview `ref` with explicit slot values ("with example values").
 *
 * The request body carries ONLY `slot_values`: `LoopTemplatePreviewRequest` is
 * `extra="forbid"`, so sending draft prompts would 422. The server renders the
 * stored template, which is why the caller flushes pending autosave first —
 * see `LoopTemplatePreviewPanel`.
 */
export async function previewLoopTemplate(
  slug: string,
  ref: string,
  slotValues: Record<string, unknown>,
): Promise<LoopTemplatePreview> {
  const { data } = await api.post<LoopTemplatePreview>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/preview`,
    { slot_values: slotValues },
  );
  return data;
}

/** Preview `ref` rehearsed against a real board (autofill + that board's rails). */
export async function previewBoardLoopTemplate(
  slug: string,
  boardId: string,
  ref: string,
  slotValues: Record<string, unknown> = {},
): Promise<LoopTemplatePreview> {
  const { data } = await api.post<LoopTemplatePreview>(
    `/workspaces/${slug}/boards/${boardId}/loop-templates/${encodeURIComponent(ref)}/preview`,
    { slot_values: slotValues },
  );
  return data;
}

/**
 * One setup-contract requirement judged against a board.
 *
 * `fix_id` encodes its own argument (`create_column:active`), so applying a
 * fix needs no second lookup — and a null one means the server offers no
 * repair, which is the ONLY reason the UI may not render a Fix button.
 */
export interface LoopTemplateFitCheck {
  id: string;
  requirement: string;
  status: "ok" | "missing" | "warn";
  evidence: string;
  fix_id?: string | null;
}

/** What one autofilled slot got, and where the value came from. */
export interface LoopTemplateAutofill {
  value: unknown;
  source?: string;
}

export interface LoopTemplateFit {
  template: Record<string, unknown>;
  checks: LoopTemplateFitCheck[];
  autofill: Record<string, LoopTemplateAutofill>;
  board_frozen: boolean;
  completion_query_matches_run_label?: boolean | null;
}

export interface LoopTemplateFitApplyResult {
  fix_id: string;
  outcome: "applied" | "skipped_already_satisfied" | "rejected";
  detail: string;
}

/** The refreshed report plus a per-fix ledger — same shape the checklist draws
 * from, so applying a fix is not a second rendering path. */
export interface LoopTemplateFitApply extends LoopTemplateFit {
  applied: LoopTemplateFitApplyResult[];
}

function boardTemplateUrl(slug: string, boardId: string, ref: string): string {
  return `/workspaces/${slug}/boards/${boardId}/loop-templates/${encodeURIComponent(ref)}`;
}

/** How well `ref` fits THIS board: checklist + the slot values it can pre-fill. */
export async function fetchLoopTemplateFit(
  slug: string,
  boardId: string,
  ref: string,
): Promise<LoopTemplateFit> {
  const { data } = await api.get<LoopTemplateFit>(
    `${boardTemplateUrl(slug, boardId, ref)}/fit`,
  );
  return data;
}

/** Run advertised fixes. Ids come verbatim from a report — never composed here. */
export async function applyLoopTemplateFixes(
  slug: string,
  boardId: string,
  ref: string,
  fixIds: string[],
): Promise<LoopTemplateFitApply> {
  const { data } = await api.post<LoopTemplateFitApply>(
    `${boardTemplateUrl(slug, boardId, ref)}/fit/apply`,
    { fix_ids: fixIds },
  );
  return data;
}

export async function duplicateLoopTemplate(
  slug: string,
  ref: string,
  choice: { newSlug?: string; newName?: string } = {},
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/duplicate`,
    // Omitted, not null: an absent `new_slug` is what tells the server to walk
    // -copy, -copy-2, … itself, and the request schema forbids extra keys.
    {
      ...(choice.newSlug ? { new_slug: choice.newSlug } : {}),
      ...(choice.newName ? { new_name: choice.newName } : {}),
    },
  );
  return data;
}

export async function archiveLoopTemplate(
  slug: string,
  ref: string,
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/archive`,
    {},
  );
  return data;
}

export async function unarchiveLoopTemplate(
  slug: string,
  ref: string,
): Promise<LoopTemplateDetail> {
  const { data } = await api.post<LoopTemplateDetail>(
    `${templatesUrl(slug)}/${encodeURIComponent(ref)}/unarchive`,
    {},
  );
  return data;
}

export interface ProposedTemplateSettings {
  slot_values: Record<string, unknown>;
  loop_config: Record<string, unknown>;
  draft: false;
  version: number;
}
export async function previewProposedTemplateFit(slug: string, boardId: string, ref: string, body: ProposedTemplateSettings, signal?: AbortSignal) {
  const [fit, preview] = await Promise.all([
    api.post<LoopTemplateFit>(`${boardTemplateUrl(slug, boardId, ref)}/fit`, body, { signal }),
    api.post<LoopTemplatePreview>(`${boardTemplateUrl(slug, boardId, ref)}/preview`, body, { signal }),
  ]);
  return { fit: fit.data, preview: preview.data };
}
