// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package llm

import "os/exec"

// setProcessGroup is a no-op on Windows; the production runner is POSIX.
// Stub exists so the cross-platform build still type-checks.
func setProcessGroup(_ *exec.Cmd) {}
