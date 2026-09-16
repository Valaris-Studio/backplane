// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import type { KeyDecision } from "@/types/definition";

interface Props {
  items: KeyDecision[];
  onChange: (items: KeyDecision[]) => void;
  workspaceSlug: string;
}

export function DecisionsSection({ items, onChange, workspaceSlug }: Props) {
  const { t } = useTranslation();

  function addItem() {
    onChange([...items, { decision: "", rationale: "" }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, patch: Partial<KeyDecision>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } as KeyDecision : item)));
  }

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="flex flex-1 flex-col gap-2">
            <Textarea
              value={item.decision}
              onChange={(e) => updateItem(index, { decision: e.target.value })}
              placeholder={t("definitions.decisionPlaceholder")}
              className="min-h-[80px] resize-y"
            />
            <RichTextEditor
              content={item.rationale}
              onChange={(val) => updateItem(index, { rationale: val })}
              placeholder={t("definitions.rationalePlaceholder")}
              workspaceSlug={workspaceSlug}
              className="max-h-[70vh] overflow-y-auto"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeItem(index)}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addItem}>
        <Plus className="h-4 w-4" />
        {t("common.add")}
      </Button>
    </div>
  );
}
