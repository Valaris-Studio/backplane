// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, useState, type KeyboardEvent } from "react";

// A term that explains itself on hover and on keyboard focus. The tip stays in
// the DOM so aria-describedby always reads it; CSS only decides when it shows.
export function UsageTermTip({ label, tip }: { label: string; tip: string }) {
  const tipId = useId();
  const [dismissed, setDismissed] = useState(false);
  const restore = () => setDismissed(false);

  // Escape closes a showing tip first; preventDefault keeps the shell from also hiding the popover.
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape" || dismissed) return;
    event.preventDefault();
    setDismissed(true);
  };

  return (
    <span className="home-tip" onMouseLeave={restore}>
      <span className="home-tip-term" tabIndex={0} aria-describedby={tipId} onKeyDown={onKeyDown} onBlur={restore}>
        {label}
      </span>
      <span className="home-tip-bubble" role="tooltip" id={tipId} data-dismissed={dismissed}>
        {tip}
      </span>
    </span>
  );
}
