// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";
import { useLeaveRouteGuard } from "../hooks/useLeaveRouteGuard";

/**
 * Stops an in-app navigation that would abandon the template's unsaved draft.
 *
 * Its own component rather than shell code so it sits INSIDE
 * `TemplateDraftProvider` — the shell that renders the provider cannot read the
 * store it is creating.
 */
export function TemplateLeaveGuard({ stayWithin }: { stayWithin: string }) {
  const store = useTemplateDraftContext();
  const [pending, setPending] = useState<string | null>(null);

  const { navigate } = useLeaveRouteGuard({
    // A system template is never editable, so the listener is not even bound.
    enabled: !store.readOnly,
    isDirty: store.hasUnsavedWork,
    stayWithin,
    onIntercept: setPending,
  });

  const leave = (href: string | null) => {
    setPending(null);
    if (href) navigate(href);
  };

  return (
    <UnsavedChangesPrompt
      open={pending !== null}
      // Saving into a latched conflict is refused at persist(), so offering
      // Save there would read as a silent failure — Discard and the header's
      // Reload are the honest ways out.
      canSave={!store.conflict}
      onSave={() => {
        // Await the flush before navigating. The store's unmount flush would
        // issue the same PATCH either way, so this is not about the request
        // getting sent — it is about a save that FAILS: a 409 latches conflict,
        // and leaving first would drop the operator on another page with their
        // work silently unsaved and the banner they needed left behind.
        const href = pending;
        void store.flush().then((landed) => {
          if (landed) leave(href);
        });
      }}
      onDiscard={() => {
        // Revert BEFORE navigating. The store flushes whatever is still dirty
        // when it unmounts, so discarding without reverting would PATCH the
        // very text the operator just threw away.
        const href = pending;
        void store.reload().then(() => leave(href));
      }}
      onKeepEditing={() => setPending(null)}
    />
  );
}
