// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSessionRealtime } from "@/features/sessions/api/use-session-realtime";

export function SessionRealtimeOwner({ slug }: { slug: string }) {
  useSessionRealtime(slug);
  return null;
}
