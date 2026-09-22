// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { use, type ReactNode } from "react";

export function InitialCatalog({ ready, children }: { ready: Promise<void>; children: ReactNode }) {
  use(ready);
  return children;
}
