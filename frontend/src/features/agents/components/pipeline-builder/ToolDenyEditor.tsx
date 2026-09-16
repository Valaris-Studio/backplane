// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
}

export function ToolDenyEditor({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  function addPattern() {
    const trimmed = draft.trim();
    if (!trimmed || value.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  function removePattern(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div id={id} data-testid="tool-deny-editor" className="space-y-2">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("pipelineBuilder.llm.toolPolicy.empty")}
        </p>
      ) : (
        <ul className="space-y-1">
          {value.map((pattern, index) => (
            <li
              key={index}
              data-testid={`tool-deny-row-${index}`}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border/70 bg-surface-1/40 px-2 py-1"
            >
              <code className="truncate font-mono text-xs">{pattern}</code>
              <button
                type="button"
                onClick={() => removePattern(index)}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-muted/40 hover:text-destructive"
                aria-label={t("pipelineBuilder.llm.toolPolicy.removePattern", {
                  pattern,
                })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          data-testid="tool-deny-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addPattern();
            }
          }}
          placeholder={t("pipelineBuilder.llm.toolPolicy.addPlaceholder")}
          className="h-8 font-mono text-xs"
        />
        <button
          type="button"
          onClick={addPattern}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-border/70 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40"
        >
          <Plus className="h-3 w-3" />
          {t("pipelineBuilder.llm.toolPolicy.addPattern")}
        </button>
      </div>
    </div>
  );
}
