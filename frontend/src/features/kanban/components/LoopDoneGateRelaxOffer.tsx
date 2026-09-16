// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  /** The operator has opted OUT of the auto-relax in this editing session. */
  declined: boolean;
  onDeclinedChange: (declined: boolean) => void;
  disabled?: boolean;
}

/**
 * The done-merge gate under a self_merge landing, stated as a NOTICE with an
 * opt-out rather than an opt-in confirm: the backend now relaxes the gate by
 * default on a human self_merge save (the landing can never satisfy it), so
 * acceptance is the default and declining is the deliberate act.
 *
 * Rendered only when all three legs of the old trap hold — gate resolves ON,
 * the board has a repo, landing is `self_merge` — because that is exactly the
 * save the server will stamp. The caller owns that condition; this component
 * owns the copy and the decline lever.
 *
 * Decline is session state, not a checkbox bound to board data: it rides out
 * on the next save as `relax_done_merge_gate: false`; the default (accepted)
 * save omits the field and the SERVICE writes the override in the same
 * transaction as the config.
 */
export function LoopDoneGateRelaxOffer({
  declined,
  onDeclinedChange,
  disabled,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="board-loop-relax-gate-offer"
      role="status"
      className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      {/* The consequence copy stays visible in BOTH states: an operator
          reconsidering a decline needs the stakes restated, not just a
          button label. */}
      <p>{t("boardLoop.relaxGate.notice")}</p>
      {declined ? (
        <>
          <p data-testid="board-loop-relax-gate-declined" className="font-medium">
            {t("boardLoop.relaxGate.declined")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="board-loop-relax-gate-accept"
            disabled={disabled}
            onClick={() => onDeclinedChange(false)}
          >
            {t("boardLoop.relaxGate.accept")}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="board-loop-relax-gate-undo"
          disabled={disabled}
          onClick={() => onDeclinedChange(true)}
        >
          {t("boardLoop.relaxGate.keepArmed")}
        </Button>
      )}
    </div>
  );
}
