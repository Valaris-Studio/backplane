// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import { JsonField } from "./JsonField";
import type { KindEditorProps } from "./types";

export function McpCallEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"mcp_call">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor={id("tool")} tooltipKey="pipelineMcpCallTool">
          {t("pipelineBuilder.lifecycle.kinds.mcp_call.params.tool.label")}
        </FieldLabel>
        <Input
          id={id("tool")}
          value={params.tool ?? ""}
          disabled={disabled}
          placeholder={t("pipelineBuilder.lifecycle.kinds.mcp_call.params.tool.placeholder")}
          onChange={(e) => patch({ tool: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
      <JsonField
        label={t("pipelineBuilder.lifecycle.kinds.mcp_call.params.args.label")}
        tooltipKey="pipelineMcpCallArgs"
        value={params.args}
        disabled={disabled}
        onChange={(v) => patch({ args: v })}
      />
    </div>
  );
}
