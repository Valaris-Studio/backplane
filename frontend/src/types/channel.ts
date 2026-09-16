// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ChannelType = "email" | "slack" | "whatsapp" | "phone" | "website" | "other";

export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  channel_type: ChannelType;
  contact_value: string;
  description: string;
  metadata_json: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
