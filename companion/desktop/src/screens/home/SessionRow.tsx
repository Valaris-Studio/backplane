// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { memo } from "react";

import { SessionRowView } from "./SessionRowView";

/** Re-renders only when its own session object, board name or open state changes. */
export const SessionRow = memo(SessionRowView);
