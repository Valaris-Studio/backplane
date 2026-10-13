// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export function Spinner({ label, className = "" }: { label?: string; className?: string }) {
  if (label) return <span role="status" aria-label={label} data-spinner className={`bp-spinner ${className}`} />;
  return <span aria-hidden="true" data-spinner className={`bp-spinner ${className}`} />;
}
