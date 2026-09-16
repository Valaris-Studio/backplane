// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { downloadBlobAs } from "@/lib/download";
import type { RunnerConfig } from "@/features/git/api/use-runner-config";

const PREREQUISITE_MESSAGE_KEYS = {
  agent_key_create: "runnerConfig.prerequisiteMessages.agent_key_create",
  agent_key_export_or_rotate:
    "runnerConfig.prerequisiteMessages.agent_key_export_or_rotate",
  team_binding: "runnerConfig.prerequisiteMessages.team_binding",
  coding_agents_on_path:
    "runnerConfig.prerequisiteMessages.coding_agents_on_path",
  mcp_uv: "runnerConfig.prerequisiteMessages.mcp_uv",
  github_auth: "runnerConfig.prerequisiteMessages.github_auth",
  forge_auth: "runnerConfig.prerequisiteMessages.forge_auth",
  visual_testing: "runnerConfig.prerequisiteMessages.visual_testing",
  git_repo_missing: "runnerConfig.prerequisiteMessages.git_repo_missing",
} as const;

type KnownPrerequisiteCode = keyof typeof PREREQUISITE_MESSAGE_KEYS;
type PrerequisiteMessage = NonNullable<
  RunnerConfig["prerequisite_messages"]
>[number];
type KnownPrerequisiteMessage = Omit<PrerequisiteMessage, "code"> & {
  code: KnownPrerequisiteCode;
};
type RunnerConfigWithKnownPrerequisites = Omit<
  RunnerConfig,
  "prerequisite_messages"
> & {
  prerequisite_messages: KnownPrerequisiteMessage[];
};

const REQUIRED_PREREQUISITE_CODE_GROUPS = [
  ["agent_key_create", "agent_key_export_or_rotate"],
  ["coding_agents_on_path"],
  ["mcp_uv"],
  ["github_auth", "forge_auth"],
] as const satisfies readonly (readonly KnownPrerequisiteCode[])[];

function isKnownPrerequisiteCode(
  code: string,
): code is KnownPrerequisiteCode {
  return Object.prototype.hasOwnProperty.call(PREREQUISITE_MESSAGE_KEYS, code);
}

function isPrerequisiteParams(
  params: unknown,
): params is Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params);
}

function hasExactParamKeys(
  params: Record<string, unknown>,
  expectedKeys: readonly string[],
) {
  const actualKeys = Object.keys(params);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(params, key),
    )
  );
}

function hasExactStringParam(
  params: Record<string, unknown>,
  key: string,
) {
  return hasExactParamKeys(params, [key]) && typeof params[key] === "string";
}

function hasValidPrerequisiteParams(
  code: KnownPrerequisiteCode,
  params: Record<string, unknown>,
) {
  switch (code) {
    case "agent_key_create":
    case "mcp_uv":
    case "github_auth":
    case "visual_testing":
    case "git_repo_missing":
      return hasExactParamKeys(params, []);
    case "agent_key_export_or_rotate":
      return hasExactStringParam(params, "agent_name");
    case "team_binding":
      return hasExactStringParam(params, "workspace_slug");
    case "coding_agents_on_path":
      return (
        hasExactParamKeys(params, ["provider_ids"]) &&
        Array.isArray(params.provider_ids) &&
        params.provider_ids.every(
          (providerId) => typeof providerId === "string",
        )
      );
    case "forge_auth":
      return hasExactStringParam(params, "forge");
  }
}

function isKnownPrerequisiteMessage(
  message: PrerequisiteMessage,
): message is KnownPrerequisiteMessage {
  return (
    isKnownPrerequisiteCode(message.code) &&
    isPrerequisiteParams(message.params) &&
    hasValidPrerequisiteParams(message.code, message.params)
  );
}

function hasExactlyOneCodeFromEachRequiredGroup(
  codes: Set<KnownPrerequisiteCode>,
) {
  return REQUIRED_PREREQUISITE_CODE_GROUPS.every(
    (group) => group.filter((code) => codes.has(code)).length === 1,
  );
}

function hasCompleteStructuredPrerequisites(
  data: RunnerConfig,
): data is RunnerConfigWithKnownPrerequisites {
  const messages = data.prerequisite_messages;
  if (
    messages === undefined ||
    messages.length !== data.prerequisites.length ||
    !messages.every(isKnownPrerequisiteMessage)
  ) {
    return false;
  }

  const codes = messages.map(({ code }) => code);
  const uniqueCodes = new Set(codes);
  return (
    uniqueCodes.size === codes.length &&
    hasExactlyOneCodeFromEachRequiredGroup(uniqueCodes)
  );
}

function normalizePrerequisiteParams(params: Record<string, unknown>) {
  const providerIds = params.provider_ids;
  if (
    !Array.isArray(providerIds) ||
    !providerIds.every((providerId) => typeof providerId === "string")
  ) {
    return params;
  }

  return { ...params, provider_ids: providerIds.join(", ") };
}

interface RunnerConfigFilesProps {
  data: RunnerConfig | undefined;
  isLoading: boolean;
  isError: boolean;
  /** Optional agent-scoped YAML download (GET /agents/{id}/export-config). */
  onDownloadAgentConfig?: () => void | Promise<void>;
  onRetry?: () => void;
}

// The download-the-config surface, extracted from git/RunnerConfigDialog so the
// board git page AND the launch wizard share one implementation. Renders the
// board-scoped runner.yaml + mcp-config.json (from runner-config) and, when
// provided, the agent-scoped config bundle.
export function RunnerConfigFiles({
  data,
  isLoading,
  isError,
  onDownloadAgentConfig,
  onRetry,
}: RunnerConfigFilesProps) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const download = async () => {
    if (!onDownloadAgentConfig || downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      await onDownloadAgentConfig();
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{t("runnerConfig.error")}</p>
        {onRetry && <Button variant="outline" onClick={onRetry}>{t("runners.retry")}</Button>}
      </div>
    );
  }

  const prerequisites = hasCompleteStructuredPrerequisites(data)
    ? data.prerequisite_messages.map(({ code, params }) =>
        t(
          PREREQUISITE_MESSAGE_KEYS[code],
          { replace: normalizePrerequisiteParams(params) },
        ),
      )
    : data.prerequisites;

  return (
    <div className="space-y-6">
      {downloadError && <p role="alert" className="text-sm text-destructive">{t("runner.launchWizard.downloadError")}</p>}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("runnerConfig.prerequisitesHeading")}
        </h3>
        <ul className="space-y-2.5">
          {prerequisites.map((item, index) => (
            <li key={index} className="flex items-start gap-2.5 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="text-muted-foreground">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">
          {t("runnerConfig.filesHeading")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("runnerConfig.filesHint")}</p>
        <div className="flex flex-wrap gap-2">
          {onDownloadAgentConfig ? (
            <Button variant="outline" onClick={() => void download()} disabled={downloading} data-testid="download-agent-config">
              <FileCode2 className="h-4 w-4" />
              {t("runnerConfig.configBundle")}
              <Download className="h-3.5 w-3.5 opacity-70" />
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => downloadBlobAs("runner.yaml", new Blob([data.runner_yaml], { type: "text/yaml" }))}
              data-testid="download-board-yaml"
            >
              <FileCode2 className="h-4 w-4" />
              runner.yaml
              <Download className="h-3.5 w-3.5 opacity-70" />
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() =>
              downloadBlobAs(
                "mcp-config.json",
                new Blob([data.mcp_config_json], { type: "application/json" }),
              )
            }
            data-testid="download-mcp-config"
          >
            <FileCode2 className="h-4 w-4" />
            mcp-config.json
            <Download className="h-3.5 w-3.5 opacity-70" />
          </Button>
        </div>
      </div>
    </div>
  );
}
