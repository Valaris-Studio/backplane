// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PromptHighlightPreview } from "@/components/shared/PromptHighlightPreview";
import { copyTextToClipboard } from "@/lib/clipboard";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { isApiError } from "@/lib/api-error";
import i18nInstance from "@/i18n/config";
import { useBoards } from "@/features/kanban/api/use-boards";
import {
  previewBoardLoopTemplate,
  previewLoopTemplate,
  type LoopTemplatePreview,
} from "../api/loop-templates";
import type { DraftSlot } from "../lib/draft-content";

export type PreviewMode = "board" | "example";

/**
 * "What would the runner actually execute?" — from the author's side.
 *
 * Two modes, two endpoints (spec §5.1): "On board" rehearses against real board
 * facts so autofilled slots show their source, and "With example values" renders
 * with each SlotSpec's `example` and needs no board at all.
 *
 * The panel PREVIEWS THE SERVER'S COPY. Both preview requests are
 * `extra="forbid"` over `slot_values` alone, so draft prompts cannot ride along;
 * `onBeforePreview` flushes pending autosave first, which is what makes the
 * rendered text match what the author is looking at.
 */
export function LoopTemplatePreviewPanel({
  slug,
  templateRef,
  slots,
  runnerVars,
  onBeforePreview,
}: {
  slug: string;
  templateRef: string;
  slots: readonly DraftSlot[];
  runnerVars: readonly string[];
  onBeforePreview?: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PreviewMode>("example");
  const [boardId, setBoardId] = useState<string>("");
  const { data: boards } = useBoards(slug);
  const resultRef = useRef<HTMLDivElement>(null);

  const preview = useMutation<LoopTemplatePreview>({
    mutationFn: async () => {
      // Autosave is debounced; without this the server would render the copy
      // from before the last keystrokes and quietly show stale prompts.
      await onBeforePreview?.();
      if (mode === "board") {
        return previewBoardLoopTemplate(slug, boardId, templateRef);
      }
      return previewLoopTemplate(slug, templateRef, exampleValues(slots));
    },
  });

  const result = preview.data;
  const canRun = mode === "example" || !!boardId;

  // The panes cap at max-h-72 under the mode controls, so on a short viewport a
  // fresh result lands below the fold and reads as "the click did nothing".
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);

  return (
    <section
      data-testid="loop-template-preview-panel"
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          {t("loopTemplates.prompts.preview.title")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("loopTemplates.prompts.preview.modeLabel")}
          className="flex gap-1"
        >
          {(["board", "example"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              data-testid={`loop-template-preview-mode-${value}`}
              onClick={() => setMode(value)}
              className={
                mode === value
                  ? "rounded-[var(--radius-sm)] bg-primary px-2 py-1 text-xs text-primary-foreground"
                  : "rounded-[var(--radius-sm)] px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              }
            >
              {t(`loopTemplates.prompts.preview.mode.${value}`)}
            </button>
          ))}
        </div>

        {mode === "board" && (
          <Select value={boardId} onValueChange={setBoardId}>
            <SelectTrigger
              className="h-8 w-56 text-xs"
              data-testid="loop-template-preview-board"
              aria-label={t("loopTemplates.prompts.preview.boardLabel")}
            >
              <SelectValue
                placeholder={t(
                  "loopTemplates.prompts.preview.boardPlaceholder",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {(boards ?? []).map((board) => (
                <SelectItem key={board.id} value={board.id}>
                  {board.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canRun || preview.isPending}
          onClick={() => preview.mutate()}
          data-testid="loop-template-preview-run"
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          {t("loopTemplates.prompts.preview.run")}
        </Button>
      </div>

      {preview.isPending && (
        <div
          data-testid="loop-template-preview-pending"
          role="status"
          className="animate-pulse text-xs text-muted-foreground"
        >
          {t("loopTemplates.prompts.preview.pending")}
        </div>
      )}

      {preview.isError && (
        <div
          data-testid="loop-template-preview-error"
          role="alert"
          className="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {previewErrorMessage(preview.error, t)}
        </div>
      )}

      {/* No !isPending guard: useMutation clears `data` the moment a new
          mutation starts, so a re-run cannot leave the previous result on
          screen. The re-run test pins that, since the guard would be dead
          code rather than a safety net. */}
      {result && (
        <div
          ref={resultRef}
          className="flex flex-col gap-3"
          data-testid="loop-template-preview-result"
        >
          {!!result.findings.length && (
            <ul
              data-testid="loop-template-preview-findings"
              className="flex flex-col gap-1"
            >
              {result.findings.map((finding) => (
                <li
                  key={`${finding.code}:${finding.field}`}
                  className="text-xs text-muted-foreground"
                >
                  <Pill tint="warning">{finding.field}</Pill> {finding.message}
                </li>
              ))}
            </ul>
          )}

          {/* Autofilled values earn their SOURCE label: the operator needs to
              know a value came from the board, not from the template. */}
          {mode === "board" && !!Object.keys(result.used_values).length && (
            <dl
              data-testid="loop-template-preview-used-values"
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
            >
              {Object.entries(result.used_values).map(([name, used]) => (
                <div key={name} className="contents">
                  <dt className="font-mono text-muted-foreground">{name}</dt>
                  <dd className="truncate">
                    {String(used?.value ?? "")}
                    {used?.source && (
                      <span
                        data-testid={`loop-template-preview-source-${name}`}
                        className="ml-1.5 text-muted-foreground"
                      >
                        ({used.source})
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <PreviewPane
            label={t("loopTemplates.prompts.system.label")}
            text={result.system_prompt}
            slots={slots.map((slot) => slot.name)}
            runnerVars={runnerVars}
            testId="loop-template-preview-system"
            copyTestId="loop-template-preview-copy-system"
            copyLabel={t("loopTemplates.prompts.preview.copySystem")}
          />
          <PreviewPane
            label={t("loopTemplates.prompts.preview.loopWithTools")}
            text={result.loop_prompt_with_tools_manifest}
            slots={slots.map((slot) => slot.name)}
            runnerVars={runnerVars}
            testId="loop-template-preview-loop"
            copyTestId="loop-template-preview-copy-loop"
            copyLabel={t("loopTemplates.prompts.preview.copyLoop")}
          />
        </div>
      )}
    </section>
  );
}

/**
 * A render failure is usually a template authoring mistake the server can name
 * precisely ("slot X is not defined"), so the raw detail beats any generic copy
 * we could write. Stable error codes still win — they are localized.
 */
function previewErrorMessage(error: unknown, t: TFunction) {
  if (isApiError(error)) {
    if (error.errorCode) {
      return resolveApiErrorMessage(error, t, i18nInstance, {
        fallbackKey: "loopTemplates.prompts.preview.error",
      });
    }
    if (typeof error.detail === "string" && error.detail.trim()) {
      return error.detail;
    }
  }
  return t("loopTemplates.prompts.preview.error");
}

const COPIED_CONFIRMATION_MS = 2000;

/**
 * Each pane copies its OWN text: one shared button meant the system prompt —
 * the pane most often pasted into a runner — could not be copied at all.
 */
function PreviewPane({
  label,
  text,
  slots,
  runnerVars,
  testId,
  copyTestId,
  copyLabel,
}: {
  label: string;
  text: string;
  slots: readonly string[];
  runnerVars: readonly string[];
  testId: string;
  copyTestId: string;
  copyLabel: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // copyTextToClipboard already toasts on total failure — a second toast here
  // would double-notify the same event.
  async function handleCopy() {
    if (await copyTextToClipboard(text)) setCopied(true);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleCopy}
          data-testid={copyTestId}
          aria-label={copyLabel}
        >
          {copied ? (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t(
            copied
              ? "loopTemplates.prompts.preview.copied"
              : "loopTemplates.prompts.preview.copy",
          )}
        </Button>
      </div>
      <div data-testid={testId}>
        <PromptHighlightPreview
          text={text}
          slots={slots}
          runnerVars={runnerVars}
          className="max-h-72"
        />
      </div>
    </div>
  );
}

/** SlotSpec.example per slot — the board-less mode's stand-in for real values. */
export function exampleValues(
  slots: readonly DraftSlot[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const slot of slots) {
    if (slot.example) values[slot.name] = slot.example;
  }
  return values;
}
