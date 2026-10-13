// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package collector

import "os"

// bindToDaemon is Windows-only; Linux uses a parent-death signal (configure)
// and every OS reaps a recorded orphan at the next start (reapOrphan).
func bindToDaemon(*os.Process) error { return nil }
