// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

const DECISIONS = ["approve", "request_changes", "comment"] as const;
type Decision = (typeof DECISIONS)[number];

const MODES = ["github", "comment"] as const;
type Mode = (typeof MODES)[number];

export function PostPRReviewEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"post_pr_review">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor={id("decision")} tooltipKey="pipelinePostPrReviewDecision">
          {t("pipelineBuilder.lifecycle.kinds.post_pr_review.params.decision.label")}
        </FieldLabel>
        <Select
          value={params.decision ?? ""}
          onValueChange={(v) =>
            patch({ decision: (v || undefined) as Decision | undefined })
          }
        >
          <SelectTrigger id={id("decision")} className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {params.decision
                ? t(
                    `pipelineBuilder.lifecycle.kinds.post_pr_review.params.decision.options.${params.decision}`,
                  )
                : ""}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DECISIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {t(
                  `pipelineBuilder.lifecycle.kinds.post_pr_review.params.decision.options.${d}`,
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <FieldLabel htmlFor={id("bodyFrom")} tooltipKey="pipelinePostPrReviewBodyFrom">
          {t("pipelineBuilder.lifecycle.kinds.post_pr_review.params.body_from.label")}
        </FieldLabel>
        <Input
          id={id("bodyFrom")}
          value={params.body_from ?? ""}
          disabled={disabled}
          placeholder={t(
            "pipelineBuilder.lifecycle.kinds.post_pr_review.params.body_from.placeholder",
          )}
          onChange={(e) => patch({ body_from: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
      <div>
        <FieldLabel htmlFor={id("mode")} tooltipKey="pipelinePostPrReviewMode">
          {t("pipelineBuilder.lifecycle.kinds.post_pr_review.params.mode.label")}
        </FieldLabel>
        <Select
          value={params.mode ?? ""}
          onValueChange={(v) =>
            patch({ mode: (v || undefined) as Mode | undefined })
          }
        >
          <SelectTrigger id={id("mode")} className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {params.mode
                ? t(
                    `pipelineBuilder.lifecycle.kinds.post_pr_review.params.mode.options.${params.mode}`,
                  )
                : ""}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(
                  `pipelineBuilder.lifecycle.kinds.post_pr_review.params.mode.options.${m}`,
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
