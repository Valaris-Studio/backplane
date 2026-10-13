// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode, Ref } from "react";

// The kit's SectionHead markup with a focusable heading: focus lands here when a list's last row leaves.
export function SectionHeading({ title, aside, action, headingRef }: { title: string; aside?: ReactNode; action?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="bp-section-head">
      <h3 ref={headingRef} tabIndex={-1} className="projects-focus-target">
        {title}
      </h3>
      {aside !== undefined ? <span className="bp-section-aside">{aside}</span> : null}
      {action}
    </div>
  );
}
