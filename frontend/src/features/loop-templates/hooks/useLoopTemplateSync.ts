// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useDomainSync } from "@/hooks/useDomainSync";
import { loopTemplateKeys } from "@/lib/query-keys";

/**
 * Live-refresh the loop-template cache from the bus.
 *
 * Template writes ride the shared `config.changed` event, whose payload is
 * `{entity, action, entity_id}` (docs/events.md). Agent and prompt-config
 * saves ride the SAME namespace, so without the entity filter every unrelated
 * config save in the workspace would refetch the template library.
 *
 * Invalidating the root key (not one list variant) is deliberate: a publish
 * changes summaries, detail and version history together, and the library may
 * hold several ?q=/?sort= entries at once.
 */
export function useLoopTemplateSync(slug: string) {
  useDomainSync("config", loopTemplateKeys.all(slug), {
    filter: (event) => event.payload?.entity === "loop_template",
  });
}
