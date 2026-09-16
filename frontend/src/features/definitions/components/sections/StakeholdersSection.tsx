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
import type { Stakeholder } from "@/types/definition";
import type { WorkspaceMember } from "@/types/member";
import type { Channel } from "@/types/channel";

interface Props {
  items: Stakeholder[];
  onChange: (items: Stakeholder[]) => void;
  members: WorkspaceMember[];
  channels: Channel[];
}

export function StakeholdersSection({ items, onChange, members, channels }: Props) {
  const { t } = useTranslation();

  function addItem() {
    onChange([...items, { name: "", role: "", member_id: null, channel_id: null }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function updateItem(index: number, patch: Partial<Stakeholder>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } as Stakeholder : item)));
  }

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-border/50 p-3">
          <div className="flex items-start gap-2">
            <Input
              value={item.name}
              onChange={(e) => updateItem(index, { name: e.target.value })}
              placeholder={t("definitions.stakeholderNamePlaceholder")}
              className="flex-1"
            />
            <Input
              value={item.role}
              onChange={(e) => updateItem(index, { role: e.target.value })}
              placeholder={t("definitions.stakeholderRolePlaceholder")}
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
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("definitions.linkedMember")}
              </label>
              <Select
                value={item.member_id ?? ""}
                onValueChange={(v) => updateItem(index, { member_id: v || null })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("common.none")}>
                    {item.member_id
                      ? (members.find((m) => m.user_id === item.member_id)?.name ||
                         members.find((m) => m.user_id === item.member_id)?.email)
                      : t("common.none")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("common.none")}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.name || m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("definitions.linkedChannel")}
              </label>
              <Select
                value={item.channel_id ?? ""}
                onValueChange={(v) => updateItem(index, { channel_id: v || null })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("common.none")}>
                    {item.channel_id
                      ? channels.find((c) => c.id === item.channel_id)?.name
                      : t("common.none")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("common.none")}</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addItem}>
        <Plus className="h-4 w-4" />
        {t("common.add")}
      </Button>
    </div>
  );
}
