// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PIPELINE_EXPECTATIONS_SCOPES } from "../../../lib/contextSourceCatalog";

// Wire shape: `{ filter: { scope?: "current_role" | "all_roles" } }`.
// Omitted scope means current_role (the agent's own stage). all_roles renders
// the whole-pipeline map for a "pipeline plumber" role.
export interface PipelineExpectationsFilterValue {
  scope?: string;
}

interface Props {
  value: PipelineExpectationsFilterValue;
  onChange: (next: PipelineExpectationsFilterValue) => void;
  id?: string;
}

const DEFAULT_SENTINEL = "__default__";

export function PipelineExpectationsFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const scopeValue =
    value.scope === undefined || value.scope === ""
      ? DEFAULT_SENTINEL
      : value.scope;

  return (
    <div data-testid={id}>
      <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
        {t("pipelineBuilder.llm.contextSources.filter.pipelineExpectations.scope")}
      </label>
      <Select
        value={scopeValue}
        onValueChange={(v) =>
          onChange(v === DEFAULT_SENTINEL ? {} : { scope: v })
        }
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue>
            {value.scope ||
              t(
                "pipelineBuilder.llm.contextSources.filter.pipelineExpectations.defaultScope",
              )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>
            {t(
              "pipelineBuilder.llm.contextSources.filter.pipelineExpectations.defaultScope",
            )}
          </SelectItem>
          {PIPELINE_EXPECTATIONS_SCOPES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
