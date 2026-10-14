// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

interface StatePanelProps {
  tone?: "neutral" | "warning" | "error" | "info";
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Small print under the actions, e.g. who paused capture. */
  finePrint?: ReactNode;
}

/** A whole-view state (empty, paused from Backplane, revoked) with one clear next step. */
export function StatePanel({ tone = "neutral", icon, title, children, actions, finePrint }: StatePanelProps) {
  return (
    <div className="bp-panel" data-panel data-tone={tone}>
      <div className="bp-panel-glyph">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      {children ? <div className="bp-panel-body">{children}</div> : null}
      {actions ? <div className="bp-btn-row">{actions}</div> : null}
      {finePrint ? <p className="bp-panel-fine">{finePrint}</p> : null}
    </div>
  );
}
