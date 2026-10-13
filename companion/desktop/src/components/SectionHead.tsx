// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode, Ref } from "react";

interface SectionHeadProps {
  title: string;
  aside?: ReactNode;
  action?: ReactNode;
  /** Lets a screen move focus to the heading (e.g. when the last row it headed leaves); implies tabIndex -1. */
  headingRef?: Ref<HTMLHeadingElement>;
  tabIndex?: number;
}

export function SectionHead({ title, aside, action, headingRef, tabIndex }: SectionHeadProps) {
  const headingTabIndex = tabIndex ?? (headingRef ? -1 : undefined);
  return (
    <div className="bp-section-head">
      <h3 ref={headingRef} tabIndex={headingTabIndex}>
        {title}
      </h3>
      {aside !== undefined ? <span className="bp-section-aside">{aside}</span> : null}
      {action}
    </div>
  );
}
