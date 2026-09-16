// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditorSheet } from "@/components/ui/editor-sheet";
import {
  createLoopTemplate,
  lintLoopTemplate,
  updateLoopTemplate,
  type LoopTemplateLeakFinding,
} from "@/features/loop-templates/api/loop-templates";
import {
  PROMPT_FIELDS,
  validateSlotName,
  type CatalogSlot,
  type PromptField,
  type SlotKind,
} from "@/features/loop-templates/lib/slot-catalog";
import {
  countOccurrences,
  deriveKind,
  findMatchRange,
  replaceAll,
  replaceRange,
  type TextRange,
} from "@/features/loop-templates/lib/slot-marking";
import { loopTemplateKeys } from "@/lib/query-keys";

/** A selection the marking view resolved to string offsets in one prompt. */
export interface MarkedSelection extends TextRange {
  field: PromptField;
}

interface Props {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The board's CURRENT prompts — copied, never written back. */
  systemPrompt: string;
  loopPrompt: string;
  tools: string[];
  rails: Record<string, unknown>;
  /** Jump the panel to Bind with the freshly created template preselected. */
  onBindNow: (templateRef: string) => void;
  /**
   * Injected so tests can drive marking deterministically. jsdom implements
   * Selection only partially, and the real reader below depends on the marking
   * view being a single `<pre>` per prompt (operator direction: offsets must
   * stay stable, so no marks and no rich editor).
   */
  getSelectionRange?: () => MarkedSelection | null;
}

type Step = "identity" | "marking" | "review";

/**
 * The kinds the marking heuristic can produce.
 *
 * `deriveKind` is typed against the whole SlotKind union because the catalog
 * owns that type; marking only ever yields the two the newline rule can
 * decide, and the author refines the rest in the manager's Slots tab.
 */
type MarkedKind = Extract<SlotKind, "scalar" | "block">;

const markedKind = (text: string) => deriveKind(text) as MarkedKind;

function readDomSelection(): MarkedSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const host = (
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  )?.closest<HTMLElement>("[data-prompt-field]");
  if (!host) return null;

  // The host is a single text node per operator direction, so the range
  // offsets ARE string offsets; anything else means marks crept in.
  const field = host.dataset.promptField as PromptField;
  const probe = range.cloneRange();
  probe.selectNodeContents(host);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;
  return { field, start, end: start + range.toString().length };
}

/**
 * Turn the board's raw loop into a reusable workspace template (spec §3.2).
 *
 * The board is READ-ONLY here: prompts are copied into local draft state, the
 * author marks the board-specific bits as slots, and the result is POSTed as a
 * new draft. Binding this board to that template is a separate, explicit act —
 * hence `onBindNow` rather than an automatic PUT /loop.
 */
export function SaveAsTemplateSheet({
  slug,
  open,
  onOpenChange,
  systemPrompt,
  loopPrompt,
  tools,
  rails,
  onBindNow,
  getSelectionRange = readDomSelection,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("identity");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [tagline, setTagline] = useState("");

  const [prompts, setPrompts] = useState<Record<PromptField, string>>({
    system_prompt: systemPrompt,
    loop_prompt: loopPrompt,
  });
  const [slots, setSlots] = useState<CatalogSlot[]>([]);

  // The in-flight "make slot" prompt: a captured selection plus the name and
  // kind the author is choosing for it.
  const [pending, setPending] = useState<MarkedSelection | null>(null);
  const [slotName, setSlotName] = useState("");
  const [slotKind, setSlotKind] = useState<MarkedKind>("scalar");
  const [replaceEvery, setReplaceEvery] = useState(false);

  const [created, setCreated] = useState<{ id: string } | null>(null);
  const [findings, setFindings] = useState<LoopTemplateLeakFinding[]>([]);

  const selectedText = pending
    ? prompts[pending.field].slice(pending.start, pending.end)
    : "";
  const occurrences = selectedText
    ? countOccurrences(prompts[pending!.field], selectedText)
    : 0;

  const nameProblem = useMemo(
    () => (pending ? validateSlotName(slotName, slots, -1) : null),
    [pending, slotName, slots],
  );

  const beginMarking = () => {
    const selection = getSelectionRange();
    if (!selection) return;
    const text = prompts[selection.field].slice(selection.start, selection.end);
    setPending(selection);
    setSlotName("");
    setSlotKind(markedKind(text));
    setReplaceEvery(false);
  };

  const confirmSlot = () => {
    if (!pending || nameProblem) return;
    const field = pending.field;
    const example = prompts[field].slice(pending.start, pending.end);

    setPrompts((current) => ({
      ...current,
      [field]: replaceEvery
        ? replaceAll(current[field], example, slotName).text
        : replaceRange(current[field], pending.start, pending.end, slotName),
    }));
    setSlots((current) => [
      ...current,
      {
        name: slotName,
        kind: slotKind,
        required: false,
        label: "",
        help: "",
        // The board's own value becomes the slot's example, so the binding
        // that proved the loop works is documented on the template.
        example,
        default: null,
        enum_values: [],
        items: null,
        join: "\n",
        variants: [],
        autofill: null,
      } as CatalogSlot,
    ]);
    setPending(null);
  };

  /** Everything the author has marked so far, in the shape the API stores. */
  const contentBody = () => ({
    system_prompt: prompts.system_prompt,
    loop_prompt: prompts.loop_prompt,
    slots,
    rails_defaults: rails,
    tools,
  });

  /**
   * Save the draft: POST the first time, PATCH every time after.
   *
   * The review step's "make slot" sends the author back to marking, so this
   * runs more than once per sheet session. Re-POSTing would claim the SAME
   * derived slug the first pass already took, and the backend's
   * `_require_slug_free` answers that with a 409 — the author's second pass
   * would silently fail with the template sitting right there. Once `created`
   * holds an id, the template exists and further passes are updates to it.
   */
  const save = useMutation({
    mutationFn: async () => {
      const template = created
        ? await updateLoopTemplate(slug, created.id, {
            name: name.trim(),
            profile: {
              emoji: emoji || undefined,
              tagline: tagline || undefined,
            },
            content: contentBody(),
          })
        : await createLoopTemplate(slug, {
            slug: name
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-"),
            name: name.trim(),
            profile: {
              emoji: emoji || undefined,
              tagline: tagline || undefined,
            },
            content: contentBody(),
          });
      // No lint-before-save route exists: the draft is linted once it has an
      // id, and the warnings land in the review step. Re-linting after an
      // update is what retires the finding the author just turned into a slot.
      return { template, findings: await lintLoopTemplate(slug, template.id) };
    },
    onSuccess: ({ template, findings: found }) => {
      setCreated({ id: template.id });
      setFindings(found);
      setStep("review");
      queryClient.invalidateQueries({ queryKey: loopTemplateKeys.all(slug) });
    },
  });

  /** Pre-select a finding's text so "make slot" opens on the offending range. */
  const markFinding = (finding: LoopTemplateLeakFinding) => {
    for (const field of PROMPT_FIELDS) {
      const range = findMatchRange(prompts[field], finding.match, finding.line);
      if (range) {
        setStep("marking");
        setPending({ field, ...range });
        setSlotName("");
        setSlotKind(markedKind(finding.match));
        setReplaceEvery(false);
        return;
      }
    }
  };

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("loopTemplates.saveAs.title")}
      description={t("loopTemplates.saveAs.subtitle")}
      footer={
        step === "identity" ? (
          <Button
            type="button"
            data-testid="save-as-template-next"
            disabled={!name.trim()}
            onClick={() => setStep("marking")}
          >
            {t("loopTemplates.saveAs.next")}
          </Button>
        ) : step === "marking" ? (
          <Button
            type="button"
            data-testid={
              created ? "save-as-template-save" : "save-as-template-create"
            }
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {t(
              created
                ? "loopTemplates.saveAs.saveChanges"
                : "loopTemplates.saveAs.create",
            )}
          </Button>
        ) : null
      }
    >
      {step === "identity" && (
        <div className="space-y-4" data-testid="save-as-template-identity">
          <div className="space-y-2">
            <label htmlFor="save-as-name" className="text-sm font-medium">
              {t("loopTemplates.saveAs.nameLabel")}
            </label>
            <Input
              id="save-as-name"
              data-testid="save-as-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="save-as-emoji" className="text-sm font-medium">
              {t("loopTemplates.saveAs.emojiLabel")}
            </label>
            <Input
              id="save-as-emoji"
              data-testid="save-as-template-emoji"
              value={emoji}
              onChange={(event) => setEmoji(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="save-as-tagline" className="text-sm font-medium">
              {t("loopTemplates.saveAs.taglineLabel")}
            </label>
            <Input
              id="save-as-tagline"
              data-testid="save-as-template-tagline"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
            />
          </div>
        </div>
      )}

      {step === "marking" && (
        <div className="space-y-4" data-testid="save-as-template-marking">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("loopTemplates.saveAs.markingHint")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="save-as-template-make-slot"
              onClick={beginMarking}
            >
              {t("loopTemplates.saveAs.makeSlot")}
            </Button>
          </div>

          {pending && (
            <div
              className="space-y-2 rounded-md border border-border/70 p-2"
              data-testid="slot-name-prompt"
            >
              <label htmlFor="slot-name-input" className="text-sm font-medium">
                {t("loopTemplates.saveAs.slotNameLabel")}
              </label>
              <Input
                id="slot-name-input"
                data-testid="slot-name-input"
                value={slotName}
                onChange={(event) =>
                  setSlotName(event.target.value.toUpperCase())
                }
              />
              {nameProblem && (
                <p
                  data-testid="slot-name-error"
                  className="text-xs text-destructive"
                >
                  {t(`loopTemplates.saveAs.slotNameError.${nameProblem.code}`)}
                </p>
              )}
              <select
                data-testid="slot-kind-select"
                value={slotKind}
                onChange={(event) =>
                  setSlotKind(event.target.value as MarkedKind)
                }
                className="w-full rounded-md border border-border bg-transparent p-1 text-sm"
              >
                <option value="scalar">
                  {t("loopTemplates.saveAs.kindScalar")}
                </option>
                <option value="block">
                  {t("loopTemplates.saveAs.kindBlock")}
                </option>
              </select>
              {occurrences > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant={replaceEvery ? "default" : "outline"}
                  data-testid="slot-replace-all"
                  onClick={() => setReplaceEvery((value) => !value)}
                >
                  {t("loopTemplates.saveAs.replaceAll", {
                    count: occurrences,
                  })}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                data-testid="slot-name-confirm"
                disabled={Boolean(nameProblem)}
                onClick={confirmSlot}
              >
                {t("loopTemplates.saveAs.confirmSlot")}
              </Button>
            </div>
          )}

          {PROMPT_FIELDS.map((field) => (
            <div key={field} className="space-y-1">
              <p className="text-xs font-medium">
                {t(`loopTemplates.saveAs.field.${field}`)}
              </p>
              {/* A single text node, no marks: the offsets the selection
                  reader computes are string offsets only while this holds. */}
              <pre
                data-testid={`marking-pre-${field}`}
                data-prompt-field={field}
                className="max-h-56 overflow-auto rounded-md bg-surface-1/60 p-2 text-xs whitespace-pre-wrap"
              >
                {prompts[field]}
              </pre>
            </div>
          ))}

          {slots.length > 0 && (
            <ul className="space-y-1" data-testid="save-as-template-slot-table">
              {slots.map((slot) => (
                <li
                  key={slot.name}
                  data-testid={`slot-row-${slot.name}`}
                  className="rounded-md border border-border/70 p-2 text-xs"
                >
                  <span className="font-mono">{slot.name}</span>
                  <span className="ml-2 text-muted-foreground">
                    {slot.kind}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {slot.example}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === "review" && created && (
        <div className="space-y-4" data-testid="save-as-template-review">
          <p className="text-xs text-muted-foreground">
            {t("loopTemplates.saveAs.boardUnchanged")}
          </p>

          {findings.length > 0 && (
            <ul className="space-y-1">
              {findings.map((finding, index) => (
                <li
                  key={`${finding.code}-${finding.match}`}
                  data-testid={`leak-finding-${index}`}
                  className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  <code>{finding.match}</code>
                  <p>{finding.hint}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid={`leak-finding-${index}-make-slot`}
                    onClick={() => markFinding(finding)}
                  >
                    {t("loopTemplates.saveAs.makeSlot")}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              data-testid="save-as-template-open-manager"
              onClick={() =>
                navigate(`/${slug}/runner/loops/${created.id}/prompts`)
              }
            >
              {t("loopTemplates.saveAs.openManager")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="save-as-template-bind-now"
              onClick={() => onBindNow(created.id)}
            >
              {t("loopTemplates.saveAs.bindNow")}
            </Button>
          </div>
        </div>
      )}
    </EditorSheet>
  );
}
