// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// passthroughEnv reaches the daemon so it uses the same data directory and
// Beacon artifact as the shell that installed the service.
var passthroughEnv = []string{store.EnvHome, envBeaconArtifact, envOtelcolArtifact}

func (a *app) serviceManager() (service.Manager, store.Layout, error) {
	layout, err := a.layout()
	if err != nil {
		return nil, layout, err
	}
	environment := map[string]string{}
	for _, key := range passthroughEnv {
		if value := a.getenv(key); value != "" {
			environment[key] = value
		}
	}
	user := a.getenv("USERNAME")
	if domain := a.getenv("USERDOMAIN"); domain != "" && user != "" {
		user = domain + `\` + user
	}
	spec := service.Spec{Executable: a.daemonExecutable(), DataDir: layout.Root, Home: a.home, Env: environment, UID: a.uid, User: user, ConfigHome: a.getenv("XDG_CONFIG_HOME"), IsRunning: func() bool { return daemonRunning(layout) }}
	manager, err := service.New(a.goos, spec, a.serviceRunner)
	return manager, layout, err
}

func (a *app) service(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("%w: service install|uninstall|start|stop|status", errUsage)
	}
	manager, layout, err := a.serviceManager()
	if err != nil {
		return err
	}
	actions := map[string]func(context.Context) error{
		"install":   manager.Install,
		"uninstall": manager.Uninstall,
		"start":     manager.Start,
		"stop":      manager.Stop,
		"status":    func(context.Context) error { return nil },
	}
	action, ok := actions[args[0]]
	if !ok {
		return fmt.Errorf("%w: service install|uninstall|start|stop|status", errUsage)
	}
	if err := action(ctx); err != nil {
		return err
	}
	if args[0] == "uninstall" {
		// The daemon is stopped, so its logs, which can hold local paths,
		// are no longer written; the task definition directory is empty.
		if err := os.RemoveAll(layout.LogsDir()); err != nil {
			return err
		}
		if err := os.Remove(layout.ServiceDir()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	status, err := manager.Status(ctx)
	if err != nil {
		return err
	}
	return a.printJSON(map[string]any{"service": status, "daemon_running": daemonRunning(layout)})
}
