// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

/** Onboarding's progress dots, read as one image: "Step n of N". */
export function Stepper({ current, total }: { current: number; total: number }) {
  const step = Math.min(Math.max(current, 1), total);
  return (
    <span className="bp-stepper" role="img" aria-label={`Step ${step} of ${total}`}>
      {Array.from({ length: total }, (_, index) => {
        const position = index + 1;
        const state = position < step ? "done" : position === step ? "current" : "todo";
        return <i key={position} data-step={state} />;
      })}
    </span>
  );
}
