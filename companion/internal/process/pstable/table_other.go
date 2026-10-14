// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !darwin

package pstable

import "github.com/Valaris-Studio/backplane/companion/internal/process"

// SystemTable is nil, so callers skip the checks that need it.
// Known gap (xplat D9): no Linux/Windows process table in v1, so the Codex app-server checks are skipped.
func SystemTable() process.Table { return nil }
