// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { PromptHighlightPreview } from "@/components/shared/PromptHighlightPreview";
import {
  TemplateVarPalette,
  type PaletteGroup,
} from "@/components/shared/TemplateVarPalette";
import { useLoopTemplateList } from "../hooks/useLoopTemplateList";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";
import {
  readPrompt,
  readSlots,
  variantFills,
  type DraftSlot,
} from "../lib/draft-content";
import { insertAtCaret, validatePrompts } from "../lib/prompt-validation";
import { blankSlot, readCatalog, type CatalogSlot } from "../lib/slot-catalog";
import { LoopTemplatePreviewPanel } from "./LoopTemplatePreviewPanel";

type PromptField = "system_prompt" | "loop_prompt";

const FIELDS: PromptField[] = ["system_prompt", "loop_prompt"];

/**
 * Spec §5.1 Prompts tab — where a workspace template's kernel is authored.
 *
 * Slots are first-class: the palette inserts them, the highlight pane shows
 * them, and the chips mirror the publish validator so problems surface while
 * typing rather than at Publish. System templates are CODE-defined, so this
 * tab renders them read-only (previews still work) instead of offering edits
 * the server would refuse.
 */
export function LoopTemplatePromptsTab({
  slug,
  templateRef,
}: {
  slug: string;
  templateRef: string;
}) {
  const { t } = useTranslation();
  const draft = useTemplateDraftContext();
  const { data: catalog } = useLoopTemplateList(slug);

  const caretRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [newSlotOpen, setNewSlotOpen] = useState(false);
  const [newSlotName, setNewSlotName] = useState("");
  const [activeField, setActiveField] = useState<PromptField>("loop_prompt");

  // The runner's Go-template vocabulary is RELAYED from the server, never
  // restated here: a runner that gains a var must not need a UI change.
  const runnerVars = useMemo(() => catalog?.meta?.runner_vars ?? [], [catalog]);

  const content = draft.draft?.content;
  const systemPrompt = readPrompt(content, "system_prompt");
  const loopPrompt = readPrompt(content, "loop_prompt");
  const slots = useMemo(() => readSlots(content), [content]);

  // Re-tokenizing a 37 KB kernel on every keystroke is the one real perf risk
  // here, so validation is memoized on the texts it actually reads.
  const issues = useMemo(
    () =>
      validatePrompts({
        systemPrompt,
        loopPrompt,
        slotNames: slots.map((slot) => slot.name),
        variantFills: variantFills(slots),
        runnerVars,
      }),
    [systemPrompt, loopPrompt, slots, runnerVars],
  );

  if (draft.isLoading || !draft.draft) {
    return (
      <Skeleton
        className="h-64 w-full"
        data-testid="loop-template-prompts-loading"
      />
    );
  }

  function insertToken(token: string) {
    const field = activeField;
    const node = caretRefs.current[field];
    const current = field === "system_prompt" ? systemPrompt : loopPrompt;
    const start = node?.selectionStart ?? current.length;
    const end = node?.selectionEnd ?? start;
    const { text, caret } = insertAtCaret(current, token, start, end);
    draft.setField(`content.${field}`, text);
    // Restore the caret after React re-renders with the spliced text, so a
    // second insert lands after the first rather than back at the old offset.
    requestAnimationFrame(() => {
      const el = caretRefs.current[field];
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function handleCreateSlot() {
    const name = newSlotName.trim().toUpperCase();
    if (!name) return;
    // blankSlot(), not a literal: the Slots tab owns the catalog row's shape
    // and the publish validator forbids unknown kinds, so restating a partial
    // literal here is exactly how the two tabs drifted (card 41dc5cb8).
    // Rows persist verbatim, so the write must start from the full catalog
    // rows, not the lossy palette projection in `slots`.
    const next: CatalogSlot[] = [...readCatalog(content), blankSlot(name)];
    // Written through the shared draft so the Slots tab (p3-05a) sees the new
    // entry immediately — one draft, many tabs.
    draft.setField("content.slots", next);
    setNewSlotName("");
    setNewSlotOpen(false);
    insertToken(`<<${name}>>`);
  }

  const groups: PaletteGroup[] = [
    {
      id: "runner",
      label: t("loopTemplates.prompts.palette.runner"),
      items: runnerVars.map((name) => ({
        token: `{{.${name}}}`,
        label: name,
      })),
    },
    {
      id: "slots",
      label: t("loopTemplates.prompts.palette.slots"),
      items: slots.map((slot) => ({
        token: `<<${slot.name}>>`,
        label: slot.name,
        kind: slot.kind,
        required: slot.required,
      })),
    },
  ];

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="loop-template-prompts-tab"
    >
      {draft.readOnly && (
        <p
          data-testid="loop-template-prompts-readonly"
          className="text-xs text-muted-foreground"
        >
          {t("loopTemplates.prompts.readOnly")}
        </p>
      )}

      {!draft.readOnly && (
        <div className="flex flex-col gap-2">
          <TemplateVarPalette
            groups={groups}
            onInsert={insertToken}
            legend={t("loopTemplates.prompts.palette.legend")}
            insertAria={(token) =>
              t("loopTemplates.prompts.palette.insert", { token })
            }
            onNewSlot={() => setNewSlotOpen((open) => !open)}
            newSlotLabel={t("loopTemplates.prompts.palette.newSlot")}
          />

          {newSlotOpen && (
            <div className="flex items-center gap-2">
              <Input
                value={newSlotName}
                onChange={(event) => setNewSlotName(event.target.value)}
                placeholder={t("loopTemplates.prompts.newSlot.placeholder")}
                aria-label={t("loopTemplates.prompts.newSlot.nameLabel")}
                data-testid="loop-template-new-slot-name"
                className="h-8 w-56 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleCreateSlot}
                data-testid="loop-template-new-slot-add"
              >
                {t("loopTemplates.prompts.newSlot.add")}
              </Button>
            </div>
          )}
        </div>
      )}

      {!!issues.length && (
        <ul
          data-testid="loop-template-prompt-issues"
          className="flex flex-wrap gap-1.5"
        >
          {issues.map((issue) => (
            <li key={`${issue.kind}:${issue.name}`}>
              <Pill
                tint="warning"
                data-testid={`loop-template-issue-${issue.kind}-${issue.name}`}
              >
                {t(`loopTemplates.prompts.issues.${issue.kind}`, {
                  name: issue.name,
                })}
              </Pill>
            </li>
          ))}
        </ul>
      )}

      {FIELDS.map((field) => (
        <PromptEditor
          key={field}
          field={field}
          value={field === "system_prompt" ? systemPrompt : loopPrompt}
          readOnly={draft.readOnly}
          slots={slots}
          runnerVars={runnerVars}
          onFocus={() => setActiveField(field)}
          onChange={(text) => draft.setField(`content.${field}`, text)}
          registerRef={(node) => {
            caretRefs.current[field] = node;
          }}
        />
      ))}

      <LoopTemplatePreviewPanel
        slug={slug}
        templateRef={templateRef}
        slots={slots}
        runnerVars={runnerVars}
        onBeforePreview={draft.flush}
      />
    </div>
  );
}

function PromptEditor({
  field,
  value,
  readOnly,
  slots,
  runnerVars,
  onChange,
  onFocus,
  registerRef,
}: {
  field: PromptField;
  value: string;
  readOnly: boolean;
  slots: readonly DraftSlot[];
  runnerVars: readonly string[];
  onChange: (text: string) => void;
  onFocus: () => void;
  registerRef: (node: HTMLTextAreaElement | null) => void;
}) {
  const { t } = useTranslation();
  // Collapsed by default: the highlight pane re-renders the whole prompt, and
  // Coding Loop v2 kernels run ~37 KB.
  const [showHighlight, setShowHighlight] = useState(false);
  const labelKey =
    field === "system_prompt"
      ? "loopTemplates.prompts.system"
      : "loopTemplates.prompts.loop";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <RichTooltip i18nKey={`loopTemplates.${field}`}>
          <label
            htmlFor={`loop-template-${field}`}
            className="text-sm font-medium"
          >
            {t(`${labelKey}.label`)}
          </label>
        </RichTooltip>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShowHighlight((open) => !open)}
          data-testid={`loop-template-highlight-toggle-${field}`}
          aria-expanded={showHighlight}
        >
          {t("loopTemplates.prompts.highlight")}
        </Button>
      </div>

      <Textarea
        id={`loop-template-${field}`}
        ref={registerRef}
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`loop-template-${field}`}
        className="min-h-64 font-mono text-xs"
      />

      {showHighlight && (
        <div data-testid={`loop-template-highlight-${field}`}>
          <PromptHighlightPreview
            text={value}
            slots={slots.map((slot) => slot.name)}
            runnerVars={runnerVars}
          />
        </div>
      )}
    </div>
  );
}
