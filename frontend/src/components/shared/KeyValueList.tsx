// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KeyValueItem {
  key: string;
  value: string;
}

interface KeyValueListProps {
  items: KeyValueItem[];
  onChange: (items: KeyValueItem[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueList({
  items,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: KeyValueListProps) {
  const { t } = useTranslation();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  function addItem() {
    const key = newKey.trim();
    const value = newValue.trim();
    if (!key) return;
    onChange([...items, { key, value }]);
    setNewKey("");
    setNewValue("");
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, field: "key" | "value", val: string) {
    onChange(items.map((item, i) => (i === index ? { ...item, [field]: val } : item)));
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={item.key}
            onChange={(e) => updateItem(index, "key", e.target.value)}
            placeholder={keyPlaceholder}
            className="flex-1"
          />
          <Input
            value={item.value}
            onChange={(e) => updateItem(index, "value", e.target.value)}
            placeholder={valuePlaceholder}
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
      <div className="flex items-center gap-2">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={keyPlaceholder}
          className="flex-1"
        />
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder={valuePlaceholder}
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addItem}
          disabled={!newKey.trim()}
          className="shrink-0"
        >
          <Plus className="h-4 w-4" />
          {t("common.add")}
        </Button>
      </div>
    </div>
  );
}
