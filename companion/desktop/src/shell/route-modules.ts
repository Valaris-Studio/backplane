// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Runs every screen's routes.ts for its registerRoute side effects.
import.meta.glob("../screens/*/routes.{ts,tsx}", { eager: true });
