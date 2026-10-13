// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";

import { trackPopoverVisibility, usePopoverVisible } from "../../shell/popover-visibility";
import { catalogResource } from "../../stores/projects";

/**
 * Asks for the board catalog again each time the panel comes back on screen,
 * e.g. after a board was created in the browser. A failed fetch keeps the last list.
 */
export function useCatalogRefreshOnReturn(): void {
  useEffect(() => trackPopoverVisibility(), []);
  const visible = usePopoverVisible();
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) catalogResource.refresh();
    wasVisible.current = visible;
  }, [visible]);
}
