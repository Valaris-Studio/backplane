// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Reference } from "@/types/definition";

interface Props {
  items: Reference[];
  onChange: (items: Reference[]) => void;
}

export function ReferencesSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  function addItem() {
    onChange([...items, { label: "", url: "" }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, patch: Partial<Reference>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } as Reference : item)));
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={item.label}
            onChange={(e) => updateItem(index, { label: e.target.value })}
            placeholder={t("definitions.referenceLabelPlaceholder")}
            className="flex-1"
          />
          <Input
            value={item.url}
            onChange={(e) => updateItem(index, { url: e.target.value })}
            placeholder={t("definitions.referenceUrlPlaceholder")}
            className="flex-1"
          />
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
