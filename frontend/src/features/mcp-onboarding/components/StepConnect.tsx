// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, ExternalLink, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useSkillCatalog } from "@/features/skills/api/use-skills";
import { getServerSurface } from "@/pages/documentation/mcp-reference/data";
import { fadeInUp } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { SkillCatalogEntry } from "@/types/skill";
import {
  composeAgentMessage,
  composeMcpServersJson,
  GIT_INSTALL_COMMAND,
  GITHUB_URL,
  PYPI_URL,
  toolsetsForIntent,
  type ConnectionPreset,
} from "../agent-handoff";
import { CopyableBlock } from "./CopyableBlock";

export function StepConnect({
  origin,
  apiKey,
  intent,
  onIntentChange,
  onNext,
  onBack,
}: {
  origin: string;
  apiKey: string | null;
  intent: ConnectionPreset;
  onIntentChange: (intent: ConnectionPreset) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { slug } = useParams();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement>(null);

  // Entrance only. The panel stays conditionally MOUNTED (not hidden) because
  // its JSON block can hold the raw API key — out of the DOM until asked for.
  // Collapse is instant by the same token, which also matches the
  // exit-faster-than-enter rule.
  useEffect(() => {
    if (!advancedOpen || !advancedRef.current) return;
    fadeInUp(advancedRef.current, { offset: 6, duration: 0.2 });
  }, [advancedOpen]);

  const agentMessage = composeAgentMessage({ origin, apiKey, intent });

  return (
    <div className="space-y-4" data-testid="wizard-step-connect">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.connectIntro")}
      </p>

      <IntentPicker intent={intent} onChange={onIntentChange} />

      <CopyableBlock
        label={t("mcpOnboarding.connectMessageLabel")}
        value={agentMessage}
        copyLabel={t("a11y.mcpOnboarding.copyAgentMessage")}
        testid="wizard-agent-message"
      />

      {apiKey === null ? (
        <p
          data-testid="wizard-key-substitute-hint"
          className="flex items-start gap-2 text-sm leading-relaxed text-[color:var(--color-warning)]"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("mcpOnboarding.connectSubstituteHint")}
        </p>
      ) : null}

      <div className="rounded-[var(--radius-md)] border border-border/60">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          data-testid="wizard-advanced-toggle"
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-foreground"
        >
          {t("mcpOnboarding.connectAdvanced")}
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200 ease-out",
              advancedOpen && "rotate-180",
            )}
            aria-hidden
          />
        </button>

        {advancedOpen ? (
          <div ref={advancedRef} className="space-y-4 border-t border-border/60 px-3 py-3.5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("mcpOnboarding.connectAdvancedIntro")}
            </p>

            {slug ? <SkillsThatFit slug={slug} intent={intent} /> : null}

            <CopyableBlock
              label={t("mcpOnboarding.connectJsonLabel")}
              value={composeMcpServersJson({ origin, apiKey, intent })}
              copyLabel={t("a11y.mcpOnboarding.copyJson")}
              testid="wizard-mcp-json"
            />

            <div>
              <h4 className="mb-2 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {t("mcpOnboarding.connectEnvHeading")}
              </h4>
              <dl className="space-y-2.5" data-testid="wizard-env-vars">
                <EnvVar
                  name="VALARIS_API_URL"
                  required
                  description={t("mcpOnboarding.connectEnvApiUrl")}
                />
                <EnvVar
                  name="VALARIS_API_KEY"
                  required
                  description={t("mcpOnboarding.connectEnvApiKey")}
                />
                <EnvVar
                  name="VALARIS_AGENT_EMAIL"
                  description={t("mcpOnboarding.connectEnvAgentEmail")}
                />
                <EnvVar
                  name="VALARIS_MCP_TOOLSETS"
                  description={t("mcpOnboarding.connectEnvToolsets")}
                />
              </dl>
            </div>

            <div>
              <CopyableBlock
                label={t("mcpOnboarding.connectGitInstallLabel")}
                value={GIT_INSTALL_COMMAND}
                copyLabel={t("a11y.mcpOnboarding.copyGitInstall")}
                testid="wizard-git-install"
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t("mcpOnboarding.connectGitInstallHint")}
              </p>
            </div>

            <div className="flex flex-wrap gap-4">
              <PackageLink
                href={PYPI_URL}
                testid="wizard-pypi-link"
                label={t("mcpOnboarding.connectPypi")}
              />
              <PackageLink
                href={GITHUB_URL}
                testid="wizard-github-link"
                label={t("mcpOnboarding.connectGithub")}
              />
            </div>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onBack} data-testid="wizard-back">
          {t("mcpOnboarding.back")}
        </Button>
        <Button onClick={onNext} data-testid="wizard-next">
          {t("mcpOnboarding.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}

const INTENT_TILES: ReadonlyArray<{
  intent: ConnectionPreset;
  titleKey: string;
  bodyKey: string;
}> = [
  {
    intent: "interactive",
    titleKey: "mcpOnboarding.connectIntentInteractive",
    bodyKey: "mcpOnboarding.connectIntentInteractiveBody",
  },
  {
    intent: "loops",
    titleKey: "mcpOnboarding.connectIntentRunner",
    bodyKey: "mcpOnboarding.connectIntentRunnerBody",
  },
  {
    intent: "everything",
    titleKey: "mcpOnboarding.connectIntentEverything",
    bodyKey: "mcpOnboarding.connectIntentEverythingBody",
  },
];

// Native radios (same shape as TemplateBindStep's variant picker) so the tiles
// are keyboard-navigable without a custom roving-tabindex implementation.
function IntentPicker({
  intent,
  onChange,
}: {
  intent: ConnectionPreset;
  onChange: (intent: ConnectionPreset) => void;
}) {
  const { t } = useTranslation();
  const heading = t("mcpOnboarding.connectIntentHeading");
  return (
    <fieldset
      role="radiogroup"
      aria-label={heading}
      data-testid="wizard-intent-picker"
      className="space-y-2"
    >
      <legend className="mb-2 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {heading}
      </legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {INTENT_TILES.map((tile) => {
          const selected = tile.intent === intent;
          const titleId = `wizard-intent-${tile.intent}-title`;
          const bodyId = `wizard-intent-${tile.intent}-body`;
          return (
            <label
              key={tile.intent}
              data-testid={`wizard-intent-${tile.intent}`}
              className={cn(
                "flex cursor-pointer gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border/60 hover:border-border",
              )}
            >
              <input
                type="radio"
                name="wizard-intent"
                value={tile.intent}
                checked={selected}
                onChange={() => onChange(tile.intent)}
                aria-labelledby={titleId}
                aria-describedby={bodyId}
                className="mt-1 shrink-0"
              />
              <span className="min-w-0">
                <span id={titleId} className="block text-sm font-medium text-foreground">
                  {t(tile.titleKey)}
                </span>
                <span
                  id={bodyId}
                  className="block text-xs leading-relaxed text-muted-foreground"
                >
                  {t(tile.bodyKey)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// The generated catalog identifies category membership by parent group title.
function selectedToolsetIds(intent: ConnectionPreset): ReadonlySet<string> {
  const surface = getServerSurface();
  const toolsets = surface.toolsets ?? [];
  const selection = toolsetsForIntent(intent);
  if (selection === "all") return new Set(toolsets.map((toolset) => toolset.id));
  const selectedGroupIds = new Set(
    selection.split(",").flatMap((id) =>
      id === "default" ? surface.default_toolset?.ids ?? [] : [id],
    ),
  );
  const groupIdByTitle = new Map(
    toolsets
      .filter((toolset) => toolset.kind === "group")
      .map((toolset) => [toolset.title, toolset.id] as const),
  );
  return new Set(
    toolsets
      .filter((toolset) => {
        const parentGroupId =
          toolset.kind === "group"
            ? toolset.id
            : groupIdByTitle.get(toolset.group);
        return parentGroupId !== undefined && selectedGroupIds.has(parentGroupId);
      })
      .map((toolset) => toolset.id),
  );
}

// Older payloads can omit toolsets; an undeclared requirement fits no preset.
function fitsHand(entry: SkillCatalogEntry, hand: ReadonlySet<string>) {
  const declared = entry.toolsets ?? [];
  return declared.length > 0 && declared.every((toolsetId) => hand.has(toolsetId));
}

function SkillsThatFit({
  slug,
  intent,
}: {
  slug: string;
  intent: ConnectionPreset;
}) {
  const { t } = useTranslation();
  const catalogQuery = useSkillCatalog(slug);
  const entries = catalogQuery.data?.entries;
  const fitting = useMemo(() => {
    const hand = selectedToolsetIds(intent);
    return (entries ?? []).filter((entry) => fitsHand(entry, hand));
  }, [entries, intent]);
  if (fitting.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="wizard-skills-fit">
      <h4 className="text-[0.65rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {t("mcpOnboarding.connectSkillsHeading")}
      </h4>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.connectSkillsBody")}
      </p>
      <ul className="flex flex-wrap gap-2">
        {fitting.map((entry) => (
          <li key={entry.catalog_id}>
            <Link
              to={`/${slug}/skills`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {entry.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EnvVar({
  name,
  description,
  required,
}: {
  name: string;
  description: string;
  required?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="font-mono text-xs font-medium text-foreground">{name}</dt>
      <Badge variant="outline" className="text-[0.65rem]">
        {required
          ? t("mcpOnboarding.connectRequired")
          : t("mcpOnboarding.connectOptional")}
      </Badge>
      <dd className="w-full text-xs leading-relaxed text-muted-foreground">
        {description}
      </dd>
    </div>
  );
}

function PackageLink({
  href,
  label,
  testid,
}: {
  href: string;
  label: string;
  testid: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testid}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}
