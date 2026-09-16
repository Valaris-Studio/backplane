// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export async function downloadAgentConfigBundle(
  agentId: string,
  agentName: string,
): Promise<void> {
  const response = await api.get(`/agents/${agentId}/export-config`, {
    responseType: "blob",
  });
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const anchor = document.createElement("a");
  anchor.href = url;
  // The endpoint streams a ZIP bundle (runner-{name}.yaml + mcp-config-{name}.json),
  // so the saved file must carry a .zip extension — a .yaml name yields an
  // unopenable file.
  anchor.download = `runner-${agentName}.zip`;
  anchor.click();
  window.URL.revokeObjectURL(url);
}
