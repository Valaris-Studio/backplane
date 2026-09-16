// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";

type SaveState = "conflict" | "saving" | "unsaved" | "saved";

/**
 * The autosave's only visible surface.
 *
 * The store has computed `dirty`/`saving`/`conflict` since it was written and
 * nothing ever rendered them, so an autosaving editor told the operator
 * nothing about whether their work was safe. Precedence is deliberate:
 * `conflict` is LATCHED — autosaving has stopped and only a reload moves
 * forward — so it must outrank a `saving` flag left over from the request that
 * lost the race.
 */
export function resolveSaveState(store: {
  conflict: boolean;
  saving: boolean;
  dirty: boolean;
}): SaveState {
  if (store.conflict) return "conflict";
  if (store.saving) return "saving";
  if (store.dirty) return "unsaved";
  return "saved";
}

export function TemplateSaveStatus() {
  const { t } = useTranslation();
  const store = useTemplateDraftContext();

  // A system template has no row to PATCH, so there is no save to report on.
  if (store.readOnly) return null;

  const state = resolveSaveState(store);

  return (
    <span className="flex items-center gap-1.5">
      <Pill
        data-testid="loop-template-save-status"
        data-state={state}
        tint={state === "saving" || state === "unsaved" ? "warning" : "muted"}
        className={
          state === "conflict"
            ? "bg-destructive/16 text-destructive"
            : undefined
        }
      >
        {t(`loopTemplates.draft.status.${state}`)}
      </Pill>
      {state === "conflict" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void store.reload()}
          data-testid="loop-template-save-status-reload"
        >
          {t("loopTemplates.draft.status.reload")}
        </Button>
      )}
    </span>
  );
}
