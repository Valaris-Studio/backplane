// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Settings } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TagInput } from "@/components/shared/TagInput";
import { useAgentDetail, useUpdateAgent } from "../hooks/useAgentMetrics";
import type { AgentMetric } from "../api/agents";

interface AgentConfigPanelProps {
  agent: AgentMetric;
  agentId: string;
  slug: string;
}

const RATE_PRESETS = [10, 30, 60, 100] as const;
const ACTION_PRESETS = ["implement", "review", "document", "mediate"] as const;

const CONFIG_PRESETS = [
  {
    key: "conservative",
    label: "agents.presets.conservative",
    values: { max_requests_per_minute: 10, budget_usd: 5.0 },
  },
  {
    key: "balanced",
    label: "agents.presets.balanced",
    values: { max_requests_per_minute: 30, budget_usd: 25.0 },
  },
  {
    key: "aggressive",
    label: "agents.presets.aggressive",
    values: { max_requests_per_minute: 100, budget_usd: 100.0 },
  },
] as const;

export function AgentConfigPanel({ agent, agentId, slug }: AgentConfigPanelProps) {
  const { t } = useTranslation();
  const { data: detail, isLoading } = useAgentDetail(agentId);
  const updateAgent = useUpdateAgent(slug);

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState("");
  const [rateLimit, setRateLimit] = useState(100);
  const [isActive, setIsActive] = useState(true);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);

  const initialized = useRef(false);
  useEffect(() => {
    if (detail && !initialized.current) {
      setName(detail.name);
      setDescription(detail.description);
      setRateLimit(detail.max_requests_per_minute);
      setIsActive(detail.is_active);
      setWorkspaces(detail.allowed_workspaces ?? []);
      setActions(detail.allowed_actions ?? []);
      initialized.current = true;
    }
  }, [detail]);

  if (isLoading) {
    return <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  const sortedJson = (arr: string[]) => JSON.stringify([...arr].sort());

  const hasChanges =
    detail != null &&
    (name !== detail.name ||
      description !== detail.description ||
      rateLimit !== detail.max_requests_per_minute ||
      isActive !== detail.is_active ||
      sortedJson(workspaces) !== sortedJson(detail.allowed_workspaces ?? []) ||
      sortedJson(actions) !== sortedJson(detail.allowed_actions ?? []));

  function handleSave() {
    const data: Record<string, unknown> = {};
    if (detail) {
      if (name !== detail.name) data.name = name;
      if (description !== detail.description) data.description = description;
      if (rateLimit !== detail.max_requests_per_minute)
        data.max_requests_per_minute = rateLimit;
      if (isActive !== detail.is_active) data.is_active = isActive;
      // Save button is disabled when workspaces is empty — backend rejects
      // empty allowlists (B3/B4 Option B), so the only reachable branch here
      // is a non-empty change.
      if (sortedJson(workspaces) !== sortedJson(detail.allowed_workspaces ?? []))
        data.allowed_workspaces = workspaces;
      if (sortedJson(actions) !== sortedJson(detail.allowed_actions ?? []))
        data.allowed_actions = actions.length > 0 ? actions : [];
    }

    if (Object.keys(data).length === 0) return;

    updateAgent.mutate(
      { agentId, data },
      {
        onSuccess: () => {
          initialized.current = false; // allow re-sync from server
          toast.success(t("agents.configSaved"));
        },
        onError: () => toast.error(t("agents.configSaveError")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Settings className="h-4 w-4" />
          {t("agents.config")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Identity */}
          <section>
            <h4 className="text-sm font-medium mb-3">{t("agents.identity")}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="text-xs text-muted-foreground flex items-center gap-1 cursor-help">
                      {t("agents.name")}
                      <Info className="h-3 w-3" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="top" variant="info">
                    <p className="text-xs max-w-[200px]">{t("agents.tooltips.name")}</p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">
                  {t("agents.type")}
                </label>
                <div className="flex h-11 items-center">
                  <Badge>{t(`agents.types.${agent.agent_type}`)}</Badge>
                </div>
              </div>
              <div className="sm:col-span-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="text-xs text-muted-foreground flex items-center gap-1 cursor-help">
                      {t("agents.description")}
                      <Info className="h-3 w-3" />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="top" variant="info">
                    <p className="text-xs max-w-[200px]">{t("agents.tooltips.description")}</p>
                  </TooltipContent>
                </Tooltip>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="min-h-[64px]"
                />
              </div>
            </div>
          </section>

          {/* Rate Limiting */}
          <section>
            <Tooltip>
              <TooltipTrigger asChild>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-1 cursor-help">
                  {t("agents.rateLimiting")}
                  <Info className="h-3 w-3" />
                </h4>
              </TooltipTrigger>
              <TooltipContent side="top" variant="info">
                <p className="text-xs max-w-[200px]">{t("agents.tooltips.rateLimit")}</p>
                <p className="text-[0.6rem] text-muted-foreground mt-1">
                  {t("agents.tooltips.impacts")}: {t("agents.tooltips.cost")}, {t("agents.tooltips.speed")}
                </p>
              </TooltipContent>
            </Tooltip>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={rateLimit}
                onChange={(e) => setRateLimit(Number(e.target.value))}
                className="w-24"
                min={1}
                max={1000}
              />
              <span className="text-xs text-muted-foreground">
                {t("agents.requestsPerMin")}
              </span>
              <div className="flex gap-1 ml-auto">
                {RATE_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    variant={rateLimit === preset ? "default" : "outline"}
                    size="sm"
                    onClick={() => setRateLimit(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
          </section>

          {/* Workspace Access */}
          <section>
            <Tooltip>
              <TooltipTrigger asChild>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-1 cursor-help">
                  {t("agents.workspaceAccess")}
                  <Info className="h-3 w-3" />
                </h4>
              </TooltipTrigger>
              <TooltipContent side="top" variant="info">
                <p className="text-xs max-w-[200px]">{t("agents.tooltips.workspaceAccess")}</p>
              </TooltipContent>
            </Tooltip>
            <TagInput
              tags={workspaces}
              onChange={setWorkspaces}
              placeholder={t("agents.workspaceAccess")}
            />
            {workspaces.length === 0 && (
              <p className="text-xs text-[color:var(--color-destructive-foreground)] mt-1.5">
                {t("agents.workspaceAccessEmpty")}
              </p>
            )}
          </section>

          {/* Allowed Actions */}
          <section>
            <Tooltip>
              <TooltipTrigger asChild>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-1 cursor-help">
                  {t("agents.allowedActions")}
                  <Info className="h-3 w-3" />
                </h4>
              </TooltipTrigger>
              <TooltipContent side="top" variant="info">
                <p className="text-xs max-w-[200px]">{t("agents.tooltips.allowedActions")}</p>
              </TooltipContent>
            </Tooltip>
            <TagInput
              tags={actions}
              onChange={setActions}
              placeholder={t("agents.allowedActions")}
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ACTION_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    if (!actions.includes(preset)) {
                      setActions([...actions, preset]);
                    }
                  }}
                  disabled={actions.includes(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
            {actions.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {t("agents.unrestricted")}
              </p>
            )}
          </section>

          {/* Status */}
          <section>
            <Tooltip>
              <TooltipTrigger asChild>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-1 cursor-help">
                  {t("agents.status")}
                  <Info className="h-3 w-3" />
                </h4>
              </TooltipTrigger>
              <TooltipContent side="top" variant="info">
                <p className="text-xs max-w-[200px]">{t("agents.tooltips.active")}</p>
                <p className="text-[0.6rem] text-muted-foreground mt-1">
                  {t("agents.tooltips.impacts")}: {t("agents.tooltips.cost")}, {t("agents.tooltips.quality")}
                </p>
              </TooltipContent>
            </Tooltip>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">{t("agents.agentActive")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("agents.agentActiveDescription")}
                </p>
              </div>
              <Button
                variant={isActive ? "default" : "outline"}
                size="sm"
                onClick={() => setIsActive(!isActive)}
              >
                {isActive ? t("agents.active") : t("agents.inactive")}
              </Button>
            </div>
          </section>

          {/* Configuration Presets */}
          <section>
            <h4 className="text-sm font-medium mb-3">{t("agents.presets.title")}</h4>
            <div className="flex gap-2">
              {CONFIG_PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  variant="outline"
                  size="sm"
                  onClick={() => setRateLimit(preset.values.max_requests_per_minute)}
                >
                  {t(preset.label)}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("agents.presets.description")}
            </p>
          </section>

          {/* Save */}
          {hasChanges && (
            <div className="flex justify-end pt-2 border-t">
              <Button
                onClick={handleSave}
                disabled={updateAgent.isPending || workspaces.length === 0}
              >
                {updateAgent.isPending
                  ? t("agents.saving")
                  : t("agents.saveChanges")}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
