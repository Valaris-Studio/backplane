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

const PARTICIPANT_ROLES = ["hero", "helper"] as const;
type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export function ClaimEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"claim">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <FieldLabel htmlFor={id("participantRole")} tooltipKey="pipelineClaimParticipantRole">
          {t("pipelineBuilder.lifecycle.kinds.claim.params.participant_role.label")}
        </FieldLabel>
        <Select
          value={params.participant_role ?? ""}
          onValueChange={(v) =>
            patch({ participant_role: (v || undefined) as ParticipantRole | undefined })
          }
        >
          <SelectTrigger id={id("participantRole")} className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {params.participant_role
                ? t(
                    `pipelineBuilder.lifecycle.kinds.claim.params.participant_role.options.${params.participant_role}`,
                  )
                : ""}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PARTICIPANT_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`pipelineBuilder.lifecycle.kinds.claim.params.participant_role.options.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <FieldLabel htmlFor={id("executionAction")} tooltipKey="pipelineClaimExecutionAction">
          {t("pipelineBuilder.lifecycle.kinds.claim.params.execution_action.label")}
        </FieldLabel>
        <Input
          id={id("executionAction")}
          value={params.execution_action ?? ""}
          disabled={disabled}
          placeholder={t(
            "pipelineBuilder.lifecycle.kinds.claim.params.execution_action.placeholder",
          )}
          onChange={(e) => patch({ execution_action: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
    </div>
  );
}
