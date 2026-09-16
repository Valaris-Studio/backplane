// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, Trash2 } from "lucide-react";
import { useDeleteChannel, useUpdateChannel } from "../api/use-channels";
import { EditorSheet } from "@/components/ui/editor-sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import type { Channel, ChannelType } from "@/types/channel";

const CHANNEL_TYPES: ChannelType[] = [
  "email",
  "slack",
  "whatsapp",
  "phone",
  "website",
  "other",
];

interface ChannelEditorProps {
  channel: Channel;
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelEditor({
  channel,
  slug,
  open,
  onOpenChange,
}: ChannelEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(channel.name);
  const [channelType, setChannelType] = useState<ChannelType>(channel.channel_type);
  const [contactValue, setContactValue] = useState(channel.contact_value);
  const [description, setDescription] = useState(channel.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateChannel = useUpdateChannel(slug);
  const deleteChannel = useDeleteChannel(slug);

  useEffect(() => {
    setName(channel.name);
    setChannelType(channel.channel_type);
    setContactValue(channel.contact_value);
    setDescription(channel.description);
  }, [channel]);

  function handleSave() {
    updateChannel.mutate({
      channelId: channel.id,
      name,
      channel_type: channelType,
      contact_value: contactValue,
      description,
    });
  }

  function handleDelete() {
    deleteChannel.mutate(channel.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        onOpenChange(false);
      },
    });
  }

  return (
    <>
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      a11yTitle={t("channels.editTitle")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateChannel.isPending}>
            {updateChannel.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("channels.namePlaceholder")}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("channels.namePlaceholder")}
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
        <label className="text-sm font-medium">{t("channels.valuePlaceholder")}</label>
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
          className="min-h-[160px] resize-none"
        />
      </div>
    </EditorSheet>
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={t("channels.deleteTitle")}
      description={t("channels.deleteConfirm")}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      pending={deleteChannel.isPending}
      onConfirm={handleDelete}
    />
    </>
  );
}
