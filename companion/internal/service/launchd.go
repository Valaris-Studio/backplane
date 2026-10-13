// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const launchdLabel = "dev.backplane.companion"

type launchd struct {
	spec   Spec
	runner Runner
}

func (l *launchd) path() string {
	return filepath.Join(l.spec.Home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func (l *launchd) domain() string  { return fmt.Sprintf("gui/%d", l.spec.UID) }
func (l *launchd) service() string { return l.domain() + "/" + launchdLabel }

func (l *launchd) registered(ctx context.Context) (bool, bool) {
	output, err := l.runner.Run(ctx, "launchctl", "print", l.service())
	return err == nil, err == nil && strings.Contains(string(output), "state = running")
}

func (l *launchd) Install(ctx context.Context) error {
	wanted := renderPlist(l.spec)
	exists, owned, current, err := definitionState(l.path(), wanted)
	if err != nil {
		return err
	}
	if exists && !owned {
		return ErrForeignDefinition
	}
	if err := ensureLogDir(l.spec); err != nil {
		return err
	}
	if current {
		// Earlier installs wrote 0644; tightening needs no launchd reload.
		if err := os.Chmod(l.path(), 0o600); err != nil {
			return err
		}
	}
	registered, _ := l.registered(ctx)
	if current && registered {
		return nil
	}
	if registered {
		// launchd keeps the loaded copy; reload so the new definition applies.
		if _, err := l.runner.Run(ctx, "launchctl", "bootout", l.service()); err != nil {
			return err
		}
	}
	if !current {
		if err := writeDefinition(l.path(), []byte(wanted), 0o600); err != nil {
			return err
		}
	}
	_, err = l.runner.Run(ctx, "launchctl", "bootstrap", l.domain(), l.path())
	return err
}

func (l *launchd) Uninstall(ctx context.Context) error {
	exists, owned, _, err := definitionState(l.path(), "")
	if err != nil || !exists {
		return err
	}
	if !owned {
		return ErrForeignDefinition
	}
	if registered, _ := l.registered(ctx); registered {
		if _, err := l.runner.Run(ctx, "launchctl", "bootout", l.service()); err != nil {
			return err
		}
	}
	return os.Remove(l.path())
}

func (l *launchd) Start(ctx context.Context) error {
	exists, owned, _, err := definitionState(l.path(), "")
	if err != nil {
		return err
	}
	if !exists || !owned {
		return ErrNotInstalled
	}
	if registered, _ := l.registered(ctx); !registered {
		_, err := l.runner.Run(ctx, "launchctl", "bootstrap", l.domain(), l.path())
		return err
	}
	_, err = l.runner.Run(ctx, "launchctl", "kickstart", l.service())
	return err
}

// Stop sends SIGTERM; the daemon exits 0, which KeepAlive does not restart.
func (l *launchd) Stop(ctx context.Context) error {
	exists, owned, _, err := definitionState(l.path(), "")
	if err != nil || !exists {
		return err
	}
	if !owned {
		return ErrForeignDefinition
	}
	if registered, _ := l.registered(ctx); !registered {
		return nil
	}
	_, err = l.runner.Run(ctx, "launchctl", "kill", "SIGTERM", l.service())
	return err
}

func (l *launchd) Status(ctx context.Context) (Status, error) {
	exists, owned, current, err := definitionState(l.path(), renderPlist(l.spec))
	if err != nil {
		return Status{}, err
	}
	status := Status{Backend: "launchd", Definition: l.path(), Installed: exists && owned, Current: current}
	status.Enabled, status.Running = l.registered(ctx)
	return status, nil
}

// xmlText escapes element text; quotes need no escaping outside attributes.
var xmlText = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace

// renderPlist restarts the daemon only after a failure exit, so `stop`
// (SIGTERM, exit 0) stays stopped until the next login.
func renderPlist(spec Spec) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ` + ownershipMarker + ` -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + launchdLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + xmlText(spec.Executable) + `</string>
		<string>run</string>
		<string>--log</string>
		<string>` + xmlText(spec.logPath()) + `</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>` + xmlText(spec.stderrPath()) + `</string>
	<key>StandardErrorPath</key>
	<string>` + xmlText(spec.stderrPath()) + `</string>
`)
	if len(spec.Env) > 0 {
		builder.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n")
		for _, key := range spec.sortedEnv() {
			builder.WriteString("\t\t<key>" + xmlText(key) + "</key>\n\t\t<string>" + xmlText(spec.Env[key]) + "</string>\n")
		}
		builder.WriteString("\t</dict>\n")
	}
	builder.WriteString("</dict>\n</plist>\n")
	return builder.String()
}
