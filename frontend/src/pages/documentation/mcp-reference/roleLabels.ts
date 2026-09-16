// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PromptDoc } from "./data";

export const PROMPT_ROLE_LABELS: Record<PromptDoc["role"], string> = {
  initializer: "Initializer",
  secretary: "Secretary",
  architect: "Architect",
  coder: "Coder",
};
