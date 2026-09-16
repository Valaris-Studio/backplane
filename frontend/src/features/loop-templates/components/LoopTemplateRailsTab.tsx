// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { ToolPicker } from "@/features/agents/components/pipeline-builder/ToolPicker";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";
import {
  NUMERIC_RAILS,
  ENUM_RAILS,
  applyRail,
  parseRailInput,
  ENUM_RAIL_NAMES,
  DECIMAL_RAILS,
  MODEL_TIERS,
  CUSTOM_MODEL,
  hasOffSwitch,
  readRailsDefaults,
  readTools,
  readDerivedRails,
  railValue,
} from "../lib/rails-catalog";

const INPUT_CLASS =
  "border-input bg-background h-8 w-full rounded-md border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60";

const SELECT_CLASS = INPUT_CLASS;

/**
 * The tooltip PANEL copy lands in p3-09; this card owns the trigger and the
 * key. `data-tooltip-key` makes the wiring assertable without rendering the
 * panel, which needs a hover the jsdom layout engine cannot drive.
 */
function RailLabel({
  rail,
  htmlFor,
  children,
}: {
  rail: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <RichTooltip i18nKey={`loopTemplates.rails.${rail}`} side="right">
      <label
        htmlFor={htmlFor}
        data-testid={`loop-template-rail-tooltip-${rail}`}
        data-tooltip-key={`loopTemplates.rails.${rail}`}
        className="text-foreground cursor-help font-mono text-xs underline decoration-dotted underline-offset-4"
      >
        {children}
      </label>
    </RichTooltip>
  );
}

// The slug/templateRef props are the SHELL's routing identity: this tab no
// longer reads them (the draft store is the shell's), but every tab keeps the
// same call signature so the shell mounts them uniformly.
export function LoopTemplateRailsTab(_props: { slug: string; templateRef: string }) {
  const { t } = useTranslation();
  const draft = useTemplateDraftContext();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState(false);

  const content = draft.draft?.content;
  const rails = useMemo(() => readRailsDefaults(content), [content]);
  const tools = useMemo(() => readTools(content), [content]);
  const derived = useMemo(() => readDerivedRails(content), [content]);

  const setField = draft.setField;

  const setRail = useCallback(
    (rail: string, value: unknown) => {
      setField("content.rails_defaults", applyRail(rails, rail, value));
    },
    [rails, setField],
  );

  const setNumericRail = useCallback(
    (rail: string, raw: string) => {
      setRail(rail, parseRailInput(rail, raw));
    },
    [setRail],
  );

  const commitJson = useCallback(
    (text: string) => {
      setJsonText(text);
      if (text.trim() === "") {
        setJsonError(false);
        setField("content.derived_rails", {});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        // A bare scalar parses fine but is not a rails map.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonError(true);
          return;
        }
        setJsonError(false);
        setField("content.derived_rails", parsed);
      } catch {
        // Invalid JSON never reaches the draft — the last good value stands.
        setJsonError(true);
      }
    },
    [setField],
  );

  if (draft.isLoading || !draft.draft) {
    return (
      <Skeleton className="h-64 w-full" data-testid="loop-template-rails-loading" />
    );
  }

  const readOnly = draft.readOnly;
  const model = railValue(rails, "model");
  const isTierModel = (MODEL_TIERS as readonly string[]).includes(model);
  const offSwitchMissing = !hasOffSwitch(tools);

  return (
    <div className="flex flex-col gap-4" data-testid="loop-template-rails-tab">
      {readOnly && (
        <p
          data-testid="loop-template-rails-readonly"
          className="text-muted-foreground text-xs"
        >
          {t("loopTemplates.rails.readOnly")}
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2">
        {NUMERIC_RAILS.map((rail) => (
          <div key={rail} className="space-y-1.5">
            <RailLabel rail={rail} htmlFor={`rail-${rail}`}>
              {rail}
            </RailLabel>
            <input
              id={`rail-${rail}`}
              data-testid={`loop-template-rail-${rail}`}
              type="number"
              className={INPUT_CLASS}
              disabled={readOnly}
              min={0}
              step={DECIMAL_RAILS.has(rail) ? 0.01 : 1}
              value={railValue(rails, rail)}
              onChange={(e) => setNumericRail(rail, e.target.value)}
            />
          </div>
        ))}

        {ENUM_RAIL_NAMES.map((rail) => (
          <div key={rail} className="space-y-1.5">
            <RailLabel rail={rail} htmlFor={`rail-${rail}`}>
              {rail}
            </RailLabel>
            <select
              id={`rail-${rail}`}
              data-testid={`loop-template-rail-${rail}`}
              className={SELECT_CLASS}
              disabled={readOnly}
              value={railValue(rails, rail)}
              onChange={(e) => setRail(rail, e.target.value)}
            >
              {(ENUM_RAILS[rail] as readonly string[]).map((option) => (
                <option key={option} value={option}>
                  {t(`loopTemplates.rails.values.${rail}.${option}`)}
                </option>
              ))}
            </select>
          </div>
        ))}

        <div className="space-y-1.5">
          <RailLabel rail="model" htmlFor="rail-model">
            model
          </RailLabel>
          <select
            id="rail-model"
            data-testid="loop-template-rail-model"
            className={SELECT_CLASS}
            disabled={readOnly}
            value={isTierModel ? model : CUSTOM_MODEL}
            onChange={(e) =>
              setRail(
                "model",
                e.target.value === CUSTOM_MODEL ? model : e.target.value,
              )
            }
          >
            {MODEL_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>
              {t("loopTemplates.rails.customModel")}
            </option>
          </select>
          {!isTierModel && (
            <input
              data-testid="loop-template-rail-model-custom"
              className={INPUT_CLASS}
              disabled={readOnly}
              value={model}
              aria-label={t("loopTemplates.rails.customModel")}
              onChange={(e) => setRail("model", e.target.value)}
            />
          )}
        </div>

        <div className="space-y-1.5">
          <RailLabel rail="provider" htmlFor="rail-provider">
            provider
          </RailLabel>
          <input
            id="rail-provider"
            data-testid="loop-template-rail-provider"
            className={INPUT_CLASS}
            disabled={readOnly}
            value={railValue(rails, "provider")}
            onChange={(e) => setRail("provider", e.target.value)}
          />
        </div>
      </section>

      <section className="space-y-2">
        <span className="text-sm font-medium">
          {t("loopTemplates.rails.toolsLabel")}
        </span>
        {offSwitchMissing && (
          <p
            data-testid="loop-template-rails-off-switch-warning"
            className="text-destructive text-xs"
          >
            {t("loopTemplates.rails.offSwitchWarning")}
          </p>
        )}
        {readOnly ? (
          <p className="text-muted-foreground font-mono text-xs">
            {tools.length ? tools.join(", ") : t("loopTemplates.rails.noTools")}
          </p>
        ) : (
          <>
            <ToolPicker
              value={tools}
              onChange={(next) => setField("content.tools", next)}
            />
            <button
              type="button"
              data-testid="loop-template-rails-tools-clear"
              className="text-muted-foreground hover:text-foreground text-xs underline"
              onClick={() => setField("content.tools", [])}
            >
              {t("loopTemplates.rails.clearTools")}
            </button>
          </>
        )}
      </section>

      <section className="space-y-2">
        <span className="text-sm font-medium">
          {t("loopTemplates.rails.derivedLabel")}
        </span>
        <p
          data-testid="loop-template-derived-rails-summary"
          className="text-muted-foreground font-mono text-xs"
        >
          {Object.keys(derived).length
            ? Object.keys(derived).join(", ")
            : t("loopTemplates.rails.derivedEmpty")}
        </p>
        {!readOnly && (
          <>
            <button
              type="button"
              data-testid="loop-template-derived-rails-toggle"
              className="text-muted-foreground hover:text-foreground text-xs underline"
              onClick={() => {
                setJsonText(JSON.stringify(derived, null, 2));
                setAdvancedOpen((open) => !open);
              }}
            >
              {t("loopTemplates.rails.derivedAdvanced")}
            </button>
            {advancedOpen && (
              <div className="space-y-1.5">
                <textarea
                  data-testid="loop-template-derived-rails-json"
                  aria-label={t("loopTemplates.rails.derivedAdvanced")}
                  rows={6}
                  className="border-input bg-background w-full rounded-md border p-2 font-mono text-xs"
                  value={jsonText ?? JSON.stringify(derived, null, 2)}
                  onChange={(e) => commitJson(e.target.value)}
                />
                {jsonError && (
                  <p
                    data-testid="loop-template-derived-rails-error"
                    className="text-destructive text-xs"
                  >
                    {t("loopTemplates.rails.derivedInvalid")}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
