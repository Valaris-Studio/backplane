// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package beacon

import "os/exec"

func hideConsole(*exec.Cmd) {}
