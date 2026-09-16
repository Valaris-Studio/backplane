// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "../FieldError";
import { FieldLabel } from "./FieldLabel";

interface JsonFieldProps {
  label: string;
  help?: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  placeholder?: string;
  tooltipKey?: string;
}

// Controlled JSON editor: keeps the raw text in local state so the user can
// type freely (including transiently-invalid JSON). Parses on blur — only a
// successfully-parsed object is propagated to the parent. On parse failure
// we surface an inline error via the existing `<FieldError />` component.
export function JsonField({
  label,
  help,
  value,
  onChange,
  disabled,
  placeholder,
  tooltipKey,
}: JsonFieldProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const stringify = (v: unknown) => {
    try {
      return JSON.stringify(v ?? {}, null, 2);
    } catch {
      return "{}";
    }
  };
  const [text, setText] = useState(() => stringify(value));
  const [parseError, setParseError] = useState(false);

  // Re-sync if the parent replaces the value out-of-band (e.g. via undo or
  // schema swap). We compare the canonical-stringify so cosmetic whitespace
  // differences don't fight the user's in-flight edits.
  useEffect(() => {
    const canonical = stringify(value);
    if (canonical !== stringify(safeParse(text))) {
      setText(canonical);
      setParseError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleBlur() {
    const trimmed = text.trim();
    if (trimmed === "") {
      setParseError(false);
      onChange({});
      setText("{}");
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setParseError(false);
        onChange(parsed as Record<string, unknown>);
        setText(JSON.stringify(parsed, null, 2));
      } else {
        setParseError(true);
      }
    } catch {
      setParseError(true);
    }
  }

  return (
    <div>
      <FieldLabel htmlFor={fieldId} tooltipKey={tooltipKey}>
        {label}
      </FieldLabel>
      <Textarea
        id={fieldId}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        className="min-h-[72px] font-mono text-xs"
      />
      {help && (
        <p className="mt-1 text-[0.7rem] text-muted-foreground">{help}</p>
      )}
      {parseError && (
        <FieldError
          errors={[
            {
              code: "json_invalid",
              field: fieldId,
              message: t("pipelineBuilder.lifecycle.json.invalid"),
            },
          ]}
        />
      )}
    </div>
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
