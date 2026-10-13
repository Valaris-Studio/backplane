// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type BannerTone = "warning" | "info" | "error" | "success";

const DEFAULT_ICON: Record<BannerTone, IconName> = {
  warning: "alert",
  info: "info",
  error: "alert",
  success: "check",
};

interface BannerProps {
  tone?: BannerTone;
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** "alert" for a failure the user just caused; omit for standing state, which must not re-announce. */
  role?: "alert" | "status";
}

export function Banner({ tone = "warning", icon, title, children, actions, role }: BannerProps) {
  return (
    <div className="bp-banner" data-banner data-tone={tone} role={role}>
      <Icon name={icon ?? DEFAULT_ICON[tone]} />
      <div className="min-w-0 flex-1">
        <div className="bp-banner-title">{title}</div>
        {children ? <div className="bp-banner-body">{children}</div> : null}
        {actions ? <div className="bp-btn-row">{actions}</div> : null}
      </div>
    </div>
  );
}
