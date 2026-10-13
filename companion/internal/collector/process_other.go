// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !linux && !windows

package collector

import "os/exec"

// Without a parent-death signal, a collector orphaned by a crashed daemon is
// reaped from its pid file at the next start.
func configure(*exec.Cmd) {}
