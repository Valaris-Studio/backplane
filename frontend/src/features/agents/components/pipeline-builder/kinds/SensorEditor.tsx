// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import { JsonField } from "./JsonField";
import type { KindEditorProps } from "./types";

export function SensorEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"sensor">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor={id("name")} tooltipKey="pipelineSensorName">
            {t("pipelineBuilder.lifecycle.kinds.sensor.params.name.label")}
          </FieldLabel>
          <Input
            id={id("name")}
            value={params.name ?? ""}
            disabled={disabled}
            placeholder={t("pipelineBuilder.lifecycle.kinds.sensor.params.name.placeholder")}
            onChange={(e) => patch({ name: e.target.value })}
            className="h-9 text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={id("onPass")} tooltipKey="pipelineSensorOnPass">
            {t("pipelineBuilder.lifecycle.kinds.sensor.params.on_pass.label")}
          </FieldLabel>
          <Input
            id={id("onPass")}
            value={params.on_pass ?? ""}
            disabled={disabled}
            placeholder={t("pipelineBuilder.lifecycle.kinds.sensor.params.on_pass.placeholder")}
            onChange={(e) => patch({ on_pass: e.target.value })}
            className="h-9 text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={id("onFail")} tooltipKey="pipelineSensorOnFail">
            {t("pipelineBuilder.lifecycle.kinds.sensor.params.on_fail.label")}
          </FieldLabel>
          <Input
            id={id("onFail")}
            value={params.on_fail ?? ""}
            disabled={disabled}
            placeholder={t("pipelineBuilder.lifecycle.kinds.sensor.params.on_fail.placeholder")}
            onChange={(e) => patch({ on_fail: e.target.value })}
            className="h-9 text-xs"
          />
        </div>
      </div>

      <JsonField
        label={t("pipelineBuilder.lifecycle.kinds.sensor.params.config.label")}
        tooltipKey="pipelineSensorConfig"
        value={params.config}
        disabled={disabled}
        onChange={(v) => patch({ config: v })}
      />
    </div>
  );
}
