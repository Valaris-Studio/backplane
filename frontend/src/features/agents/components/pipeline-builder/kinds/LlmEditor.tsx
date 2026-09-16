// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldCheckbox } from "../FieldCheckbox";
import { ToolPicker } from "../ToolPicker";
import type { KindEditorProps } from "./types";

const POST_PROCESS_KINDS = [
  "writes_code",
  "produces_decision",
  "produces_note",
  "mutates_backlog",
] as const;
type PostProcessKind = (typeof POST_PROCESS_KINDS)[number];
// Empty-string sentinel for the unset/legacy choice — the shadcn `<Select>`
// can't render an empty `<SelectItem value="">`, so we use a literal
// placeholder and map it back to `undefined` on change.
const UNSET = "__unset__";

// The Pipeline Builder intentionally exposes a narrower provider roster than
// the runner runtime: provider routing can select `codex-cli`, while this
// dropdown currently offers `claude-cli` plus disabled roadmap entries. The
// backend accepts any string, so this list is a UI-only guardrail; keep its
// tooltip explicit whenever the runtime registry grows.
const PROVIDERS = [
  { value: "claude-cli", enabled: true },
  { value: "anthropic-api", enabled: false },
  { value: "openai", enabled: false },
  { value: "gemini", enabled: false },
  { value: "local", enabled: false },
] as const;

const KNOWN_PROVIDER_VALUES = new Set<string>(PROVIDERS.map((p) => p.value));

// Tier vocabulary mirrors backend/app/services/llm_tiers.py `_DEFAULT_TIER_MAP`
// — the backend resolves a tier to a concrete provider model at dispatch and
// rejects unknown bare-word values at config-save (422). Offering anything
// else here (a past build offered "high") silently breaks dispatch; update
// both sides in lockstep if the tier set grows.
const MODEL_TIERS = ["premium", "mid", "low"] as const;

const KNOWN_MODEL_TIER_VALUES = new Set<string>(MODEL_TIERS);

export function LlmEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"llm">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  const postProcessValue = params.post_process_kind ?? UNSET;
  const providerRaw = params.provider ?? "";
  // A persisted provider we don't recognize keeps showing up in the dropdown
  // as a one-off option so the user can preserve it. Blank persists as
  // "default" (claude-cli). The "keep" affordance is a visible escape hatch:
  // user clicks it to acknowledge + lock in the foreign value.
  const persistedIsUnknown =
    providerRaw !== "" && !KNOWN_PROVIDER_VALUES.has(providerRaw);

  const modelRaw = params.model ?? "";
  // Same escape hatch as provider: an unknown persisted model (a concrete
  // provider model id, a deprecated literal, or junk like "high") stays
  // visible and selectable instead of being silently dropped.
  const modelIsUnknown = modelRaw !== "" && !KNOWN_MODEL_TIER_VALUES.has(modelRaw);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <LabelWithTooltip
            htmlFor={id("stage")}
            tooltipKey="pipelineBuilderLlmStage"
          >
            {t("pipelineBuilder.lifecycle.kinds.llm.params.stage.label")}
          </LabelWithTooltip>
          <Input
            id={id("stage")}
            value={params.stage ?? ""}
            disabled={disabled}
            placeholder={t("pipelineBuilder.lifecycle.kinds.llm.params.stage.placeholder")}
            onChange={(e) => patch({ stage: e.target.value })}
            className="h-9 text-xs"
          />
          <p className="mt-1 text-[0.7rem] text-muted-foreground">
            {t("pipelineBuilder.lifecycle.kinds.llm.params.stage.help")}
          </p>
        </div>

        <div>
          <LabelWithTooltip
            htmlFor={id("provider")}
            tooltipKey="pipelineBuilderLlmProvider"
          >
            {t("pipelineBuilder.lifecycle.kinds.llm.params.provider.label")}
          </LabelWithTooltip>
          {persistedIsUnknown && (
            <div
              data-testid="llm-provider-unknown-warning"
              className="mb-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-[0.7rem] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <div className="flex-1">
                <p>
                  {t(
                    "pipelineBuilder.lifecycle.kinds.llm.params.provider.unknownPersisted.warning",
                    { value: providerRaw },
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  data-testid="llm-provider-unknown-keep"
                  // "Keep" is a no-op for state (the value's already in
                  // params.provider) — it dismisses the warning by
                  // moving the value into the recognized roster via a
                  // local-state-only effect: re-patching the same value
                  // re-triggers the equality check and the user sees the
                  // banner stay until they pick something. The point of
                  // the button is to make "I meant that" a deliberate
                  // gesture for the operator.
                  onClick={() => patch({ provider: providerRaw })}
                  className="mt-1.5 h-7 text-[0.7rem]"
                >
                  {t(
                    "pipelineBuilder.lifecycle.kinds.llm.params.provider.unknownPersisted.keepButton",
                  )}
                </Button>
              </div>
            </div>
          )}
          <Select
            value={providerRaw === "" ? "claude-cli" : providerRaw}
            onValueChange={(v) => patch({ provider: v })}
          >
            <SelectTrigger
              id={id("provider")}
              className="h-9 text-xs"
              disabled={disabled}
              data-testid="llm-provider-trigger"
            >
              <SelectValue>
                {providerRaw === ""
                  ? t(
                      "pipelineBuilder.lifecycle.kinds.llm.params.provider.options.claude-cli.label",
                    )
                  : KNOWN_PROVIDER_VALUES.has(providerRaw)
                    ? t(
                        `pipelineBuilder.lifecycle.kinds.llm.params.provider.options.${providerRaw}.label`,
                      )
                    : t(
                        "pipelineBuilder.lifecycle.kinds.llm.params.provider.unknownPersisted.optionLabel",
                        { value: providerRaw },
                      )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem
                  key={p.value}
                  value={p.value}
                  disabled={!p.enabled}
                  data-testid={`llm-provider-option-${p.value}`}
                >
                  {t(
                    `pipelineBuilder.lifecycle.kinds.llm.params.provider.options.${p.value}.label`,
                  )}
                </SelectItem>
              ))}
              {persistedIsUnknown && (
                <SelectItem
                  key={providerRaw}
                  value={providerRaw}
                  data-testid="llm-provider-option-unknown"
                >
                  {t(
                    "pipelineBuilder.lifecycle.kinds.llm.params.provider.unknownPersisted.optionLabel",
                    { value: providerRaw },
                  )}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div>
          <LabelWithTooltip
            htmlFor={id("model")}
            tooltipKey="pipelineBuilderLlmModel"
          >
            {t("pipelineBuilder.lifecycle.kinds.llm.params.model.label")}
          </LabelWithTooltip>
          {modelIsUnknown && (
            <div
              data-testid="llm-model-unknown-warning"
              className="mb-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-[0.7rem] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p className="flex-1">
                {t(
                  "pipelineBuilder.lifecycle.kinds.llm.params.model.unknownPersisted.warning",
                  { value: modelRaw },
                )}
              </p>
            </div>
          )}
          <Select
            value={modelRaw === "" ? UNSET : modelRaw}
            onValueChange={(v) => patch({ model: v === UNSET ? undefined : v })}
          >
            <SelectTrigger
              id={id("model")}
              className="h-9 text-xs"
              disabled={disabled}
              data-testid="llm-model-trigger"
            >
              <SelectValue>
                {modelRaw === ""
                  ? t(
                      "pipelineBuilder.lifecycle.kinds.llm.params.model.options.unset",
                    )
                  : KNOWN_MODEL_TIER_VALUES.has(modelRaw)
                    ? t(
                        `pipelineBuilder.lifecycle.kinds.llm.params.model.options.${modelRaw}`,
                      )
                    : t(
                        "pipelineBuilder.lifecycle.kinds.llm.params.model.unknownPersisted.optionLabel",
                        { value: modelRaw },
                      )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET} data-testid="llm-model-option-unset">
                {t("pipelineBuilder.lifecycle.kinds.llm.params.model.options.unset")}
              </SelectItem>
              {MODEL_TIERS.map((tier) => (
                <SelectItem
                  key={tier}
                  value={tier}
                  data-testid={`llm-model-option-${tier}`}
                >
                  {t(
                    `pipelineBuilder.lifecycle.kinds.llm.params.model.options.${tier}`,
                  )}
                </SelectItem>
              ))}
              {modelIsUnknown && (
                <SelectItem
                  key={modelRaw}
                  value={modelRaw}
                  data-testid="llm-model-option-unknown"
                >
                  {t(
                    "pipelineBuilder.lifecycle.kinds.llm.params.model.unknownPersisted.optionLabel",
                    { value: modelRaw },
                  )}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div>
          <LabelWithTooltip
            htmlFor={id("postProcessKind")}
            tooltipKey="pipelineLLMPostProcessKind"
          >
            {t("pipelineBuilder.lifecycle.kinds.llm.params.post_process_kind.label")}
          </LabelWithTooltip>
          <Select
            value={postProcessValue}
            onValueChange={(v) =>
              patch({
                post_process_kind:
                  v === UNSET ? undefined : (v as PostProcessKind),
              })
            }
          >
            <SelectTrigger id={id("postProcessKind")} className="h-9 text-xs" disabled={disabled}>
              <SelectValue>
                {postProcessValue === UNSET
                  ? t("pipelineBuilder.lifecycle.kinds.llm.params.post_process_kind.options.unset")
                  : t(
                      `pipelineBuilder.lifecycle.kinds.llm.params.post_process_kind.options.${postProcessValue}`,
                    )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>
                {t("pipelineBuilder.lifecycle.kinds.llm.params.post_process_kind.options.unset")}
              </SelectItem>
              {POST_PROCESS_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`pipelineBuilder.lifecycle.kinds.llm.params.post_process_kind.options.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <LabelWithTooltip
          htmlFor={id("tools")}
          tooltipKey="pipelineBuilderLlmTools"
          as="span"
        >
          {t("pipelineBuilder.lifecycle.kinds.llm.params.tools.label")}
        </LabelWithTooltip>
        <ToolPicker
          id={id("tools")}
          value={params.tools ?? []}
          onChange={(tools) => patch({ tools })}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <FieldCheckbox
          id={id("injectDirectives")}
          label={t("pipelineBuilder.lifecycle.kinds.llm.params.inject_directives.label")}
          checked={Boolean(params.inject_directives)}
          disabled={disabled}
          onChange={(v) => patch({ inject_directives: v })}
          tooltipKey="pipelineLLMInjectDirectives"
        />
        <FieldCheckbox
          id={id("approvalEnabled")}
          label={t("pipelineBuilder.lifecycle.kinds.llm.params.approval_enabled.label")}
          checked={Boolean(params.approval_enabled)}
          disabled={disabled}
          onChange={(v) => patch({ approval_enabled: v })}
          tooltipKey="pipelineBuilderLlmApprovalEnabled"
        />
        <FieldCheckbox
          id={id("useMinimalPromptWhenUnauthored")}
          label={t(
            "pipelineBuilder.lifecycle.kinds.llm.params.use_minimal_prompt_when_unauthored.label",
          )}
          checked={Boolean(params.use_minimal_prompt_when_unauthored)}
          disabled={disabled}
          onChange={(v) => patch({ use_minimal_prompt_when_unauthored: v })}
        />
      </div>
    </div>
  );
}

// Tooltip-bearing label. `as="span"` is the escape for ToolPicker — that
// widget doesn't accept an `id`-bound <label> association, so the label is
// purely visual + the tooltip remains discoverable.
function LabelWithTooltip({
  htmlFor,
  children,
  tooltipKey,
  as = "label",
}: {
  htmlFor: string;
  children: React.ReactNode;
  tooltipKey: string;
  as?: "label" | "span";
}) {
  const className =
    "mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground";
  const inner = (
    <>
      <span>{children}</span>
      <RichTooltip i18nKey={tooltipKey} side="top">
        <Info
          data-testid={`llm-tooltip-${tooltipKey}`}
          className="h-3 w-3 text-muted-foreground/70"
          aria-hidden
        />
      </RichTooltip>
    </>
  );
  if (as === "span") {
    return <span className={className}>{inner}</span>;
  }
  return (
    <label htmlFor={htmlFor} className={className}>
      {inner}
    </label>
  );
}
