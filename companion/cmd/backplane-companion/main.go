// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Command backplane-companion captures coding-agent sessions on this machine
// and uploads them to Backplane as private sessions linked to Backplane work.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	app := newApp()
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "hook" {
		// Exit 2 would block the agent; observation must never become a decision.
		app.runHook(args[1:])
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := app.run(ctx, args); err != nil {
		fmt.Fprintln(app.stderr, "backplane-companion:", localizedError(err, locale(app.getenv)))
		os.Exit(1)
	}
}
