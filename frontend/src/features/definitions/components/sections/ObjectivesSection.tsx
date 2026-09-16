// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Objective } from "@/types/definition";

interface Props {
  items: Objective[];
  onChange: (items: Objective[]) => void;
}

const PRIORITIES = ["high", "medium", "low"] as const;

export function ObjectivesSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  function addItem() {
    onChange([...items, { text: "", priority: null }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, patch: Partial<Objective>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } as Objective : item)));
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <Input
            value={item.text}
            onChange={(e) => updateItem(index, { text: e.target.value })}
            placeholder={t("definitions.objectivePlaceholder")}
            className="flex-1"
          />
          <div className="w-36 shrink-0">
            <Select
              value={item.priority ?? ""}
              onValueChange={(v) => updateItem(index, { priority: (v || null) as Objective["priority"] })}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("cards.priorityLabel")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("common.none")}</SelectItem>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`definitions.priorities.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
