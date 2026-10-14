// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { RefObject } from "react";

/** The pairing code, split at its dash; shared by onboarding and Settings' Switch server sheet. */
export function UserCode({ code, codeRef }: { code: string; codeRef: RefObject<HTMLDivElement | null> }) {
  const [first, ...rest] = code.split("-");
  return (
    <div ref={codeRef} role="group" aria-label={`Code ${code}`} tabIndex={-1} className="ob-code">
      <span>{first}</span>
      {rest.length > 0 ? (
        <>
          <span className="ob-code-dash" aria-hidden="true">
            –
          </span>
          <span>{rest.join("-")}</span>
        </>
      ) : null}
    </div>
  );
}
