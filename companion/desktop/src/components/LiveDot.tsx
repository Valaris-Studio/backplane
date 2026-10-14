// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

/** A session receiving events right now; the ring pulses unless motion is reduced. */
export function LiveDot() {
  return <span className="bp-live-dot" data-live-dot aria-hidden="true" />;
}

export function IdleDot() {
  return <span className="bp-idle-dot" data-idle-dot aria-hidden="true" />;
}
