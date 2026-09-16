// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { ChannelList } from "@/features/channels/components/ChannelList";

export function WorkspaceChannelsPage() {
  const { slug = "" } = useParams();
  return <ChannelList slug={slug} />;
}
