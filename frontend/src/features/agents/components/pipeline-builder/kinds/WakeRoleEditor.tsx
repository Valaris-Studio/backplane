// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

// Roles are persisted as `string[]` to match the backend params_schema, but
// the UI surfaces them as a comma-separated text field — the most natural
// shape for a short list of free-form role tokens.
function parseRoles(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

export function WakeRoleEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"wake_role">) {
  const { t } = useTranslation();
  const id = useId();
  const value = (params.roles ?? []).join(", ");

  return (
    <div>
      <FieldLabel htmlFor={id} tooltipKey="pipelineWakeRoleRoles">
        {t("pipelineBuilder.lifecycle.kinds.wake_role.params.roles.label")}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={t(
          "pipelineBuilder.lifecycle.kinds.wake_role.params.roles.placeholder",
        )}
        onChange={(e) => onChange({ ...params, roles: parseRoles(e.target.value) })}
        className="h-9 text-xs"
      />
    </div>
  );
}
