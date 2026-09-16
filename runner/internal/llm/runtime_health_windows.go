// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package llm

import (
	"context"
	"io"
	"os/exec"
	"time"
)

func runOwnedRuntimeDiagnostic(ctx context.Context, path, arg string, output io.Writer) error {
	command := exec.CommandContext(ctx, path, arg)
	command.Stdout, command.Stderr = output, io.Discard
	command.WaitDelay = 200 * time.Millisecond
	return command.Run()
}
