// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package collector

import (
	"errors"
	"os"
)

// Windows has no SIGTERM; the collector is stopped with Kill (CR-9 qualifies
// a graceful path).
func terminate(process *os.Process) error { return process.Kill() }

func alive(int) bool { return false }

func commandLine(int) (string, error) { return "", errors.New("unsupported") }
