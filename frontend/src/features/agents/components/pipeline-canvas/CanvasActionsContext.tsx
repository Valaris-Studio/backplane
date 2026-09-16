// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";

// React Flow node `data` must stay serializable, so custom nodes can't receive
// callbacks through it. Instead the shell provides the interaction handlers via
// this context and every canvas node reads them with `useCanvasActions()`. All
// handlers are optional — a node with no wired action is inert, not broken.
export interface CanvasActions {
  onLaunchRunner?(agentId: string): void;
  onEditRoles?(agentId: string): void;
  onSelectRole?(nodeId: string): void;
  onToggleRole?(nodeId: string): void;
  onFocusRole?(nodeId: string): void;
  onSelectStep?(nodeId: string, roleNodeId: string): void;
  onBindRole?(role: string): void;
}

const noop = {} as const;

const CanvasActionsContext = createContext<CanvasActions>(noop);

export function CanvasActionsProvider({
  actions,
  children,
}: {
  actions: CanvasActions;
  children: React.ReactNode;
}) {
  return (
    <CanvasActionsContext.Provider value={actions}>
      {children}
    </CanvasActionsContext.Provider>
  );
}

export function useCanvasActions(): CanvasActions {
  return useContext(CanvasActionsContext);
}
