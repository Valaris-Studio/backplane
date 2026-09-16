// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { useCreateChannel } from "../api/use-channels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { ChannelType } from "@/types/channel";

const CHANNEL_TYPES: ChannelType[] = [
  "email",
  "slack",
  "whatsapp",
  "phone",
  "website",
  "other",
];

interface CreateChannelDialogProps {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateChannelDialog({
  slug,
  open,
  onOpenChange,
}: CreateChannelDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<ChannelType>("email");
  const [contactValue, setContactValue] = useState("");
  const [description, setDescription] = useState("");
  const createChannel = useCreateChannel(slug);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !contactValue.trim()) return;
    createChannel.mutate(
      {
        name: name.trim(),
        channel_type: channelType,
        contact_value: contactValue.trim(),
        description: description.trim() || undefined,
      },
      {
        onSuccess: () => {
          setName("");
          setChannelType("email");
          setContactValue("");
          setDescription("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("channels.newChannel")}</DialogTitle>
            <DialogDescription>{t("channels.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("channels.namePlaceholder")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("channels.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                {t("channels.typePlaceholder")}
                <RichTooltip i18nKey="workspace.channels.type" side="right">
                  <HelpCircle
                    aria-label={t("channels.typePlaceholder")}
                    className="h-3.5 w-3.5 text-muted-foreground"
                  />
                </RichTooltip>
              </label>
              <Select value={channelType} onValueChange={(v) => setChannelType(v as ChannelType)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("channels.typePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                {t("channels.valuePlaceholder")}
                <RichTooltip i18nKey="workspace.channels.contact" side="right">
                  <HelpCircle
                    aria-label={t("channels.valuePlaceholder")}
                    className="h-3.5 w-3.5 text-muted-foreground"
                  />
                </RichTooltip>
              </label>
              <Input
                value={contactValue}
                onChange={(e) => setContactValue(e.target.value)}
                placeholder={t("channels.valuePlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("common.descriptionOptional")}</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("common.descriptionOptional")}
                rows={3}
              />
            </div>
          </div>

          <div className="flex justify-end border-t border-border/70 pt-5">
            <Button type="submit" disabled={!name.trim() || !contactValue.trim()}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
