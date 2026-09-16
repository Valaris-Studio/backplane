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
import type { Milestone } from "@/types/definition";

interface Props {
  items: Milestone[];
  onChange: (items: Milestone[]) => void;
}

const TYPES = ["start", "deadline", "milestone"] as const;

export function MilestonesSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  function addItem() {
    onChange([...items, { title: "", date: "", type: "milestone" }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, patch: Partial<Milestone>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } as Milestone : item)));
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <Input
            value={item.title}
            onChange={(e) => updateItem(index, { title: e.target.value })}
            placeholder={t("definitions.milestoneTitlePlaceholder")}
            className="flex-1"
          />
          <Input
            type="date"
            value={item.date}
            onChange={(e) => updateItem(index, { date: e.target.value })}
            className="w-40 shrink-0"
          />
          <div className="w-36 shrink-0">
            <Select
              value={item.type}
              onValueChange={(v) => updateItem(index, { type: v as Milestone["type"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`definitions.milestoneTypes.${type}`)}
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
