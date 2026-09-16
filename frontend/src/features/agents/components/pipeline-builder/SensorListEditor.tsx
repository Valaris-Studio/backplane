// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError } from "./FieldError";
import type {
  PipelineValidationError,
  SensorDef,
} from "../../api/pipelineConfig";

interface SensorListEditorProps {
  sensors: SensorDef[];
  onChange: (next: SensorDef[]) => void;
  catalog: Array<{ name: string; description?: string | null }>;
  fieldPath: string;
  errorsByPath: Map<string, PipelineValidationError[]>;
}

export function SensorListEditor({
  sensors,
  onChange,
  catalog,
  fieldPath,
  errorsByPath,
}: SensorListEditorProps) {
  const { t } = useTranslation();
  const rootId = useId();
  const fieldId = (idx: number, name: string) => `${rootId}-${idx}-${name}`;
  const catalogNames = catalog.map((c) => c.name);
  // Fallback if no agent has yet reported a catalog.
  const fallback = ["go-test", "conflict-check", "pr-overlap"];
  const options = catalogNames.length > 0 ? catalogNames : fallback;

  function update(idx: number, patch: Partial<SensorDef>) {
    onChange(sensors.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function remove(idx: number) {
    onChange(sensors.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([
      ...sensors,
      { name: options[0] ?? "", config: {}, on_pass: "", on_fail: "" },
    ]);
  }

  return (
    <div className="space-y-2">
      {sensors.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("pipelineBuilder.sensors.empty")}
        </p>
      )}
      {sensors.map((sensor, idx) => {
        const configJson = (() => {
          try {
            return JSON.stringify(sensor.config ?? {}, null, 2);
          } catch {
            return "{}";
          }
        })();
        return (
          <div
            key={idx}
            className="space-y-2 rounded-md border border-border/60 bg-[color:var(--color-surface-1)]/40 p-2.5"
          >
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label htmlFor={fieldId(idx, "name")} className="sr-only">
                  {t("pipelineBuilder.sensors.selectName")}
                </label>
                <Select
                  value={sensor.name}
                  onValueChange={(v) => update(idx, { name: v })}
                >
                  <SelectTrigger id={fieldId(idx, "name")} className="h-9 text-xs">
                    <SelectValue placeholder={t("pipelineBuilder.sensors.selectName")}>
                      {sensor.name || t("pipelineBuilder.sensors.selectName")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={errorsByPath.get(`${fieldPath}[${idx}].name`)} />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(idx)}
                className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={fieldId(idx, "onPass")}
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  {t("pipelineBuilder.sensors.onPass")}
                </label>
                <Input
                  id={fieldId(idx, "onPass")}
                  value={sensor.on_pass ?? ""}
                  onChange={(e) => update(idx, { on_pass: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label
                  htmlFor={fieldId(idx, "onFail")}
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  {t("pipelineBuilder.sensors.onFail")}
                </label>
                <Input
                  id={fieldId(idx, "onFail")}
                  value={sensor.on_fail ?? ""}
                  onChange={(e) => update(idx, { on_fail: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor={fieldId(idx, "config")}
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                {t("pipelineBuilder.sensors.config")}
              </label>
              <Textarea
                id={fieldId(idx, "config")}
                value={configJson}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value || "{}");
                    if (parsed && typeof parsed === "object") {
                      update(idx, { config: parsed });
                    }
                  } catch {
                    // Keep raw text in UI via rerender; the parent doesn't update
                    // until the JSON is valid. Intentional — invalid JSON is
                    // dropped silently rather than propagated.
                  }
                }}
                className="min-h-[72px] font-mono text-xs"
              />
            </div>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("pipelineBuilder.sensors.add")}
      </Button>
    </div>
  );
}
