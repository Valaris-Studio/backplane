// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useState, type RefObject } from "react";

export const BOARDS_READY = "Your new board is ready to pick.";

/**
 * True once the "no boards yet" invite has turned into the board list. The
 * invite's button, which likely had focus, is gone then, so focus fell to
 * body: it moves to the list's search. Focus the owner put elsewhere stays.
 */
export function useBoardsArrival(noBoardsYet: boolean, pickerRef: RefObject<HTMLElement | null>): boolean {
  const [shownEmpty, setShownEmpty] = useState(noBoardsYet);
  const [arrived, setArrived] = useState(false);
  // Adjusted while rendering when the catalog changes (React's "derive from props" pattern).
  if (shownEmpty !== noBoardsYet) {
    setShownEmpty(noBoardsYet);
    setArrived(shownEmpty && !noBoardsYet);
  }

  useEffect(() => {
    if (!arrived) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    pickerRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [arrived, pickerRef]);

  return arrived;
}
