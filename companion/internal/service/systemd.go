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

const systemdUnit = "backplane-companion.service"

type systemd struct {
	spec   Spec
	runner Runner
}

// defaultLinuxEphemeralRoots are emptied at reboot or logout.
func defaultLinuxEphemeralRoots() []string {
	roots := []string{"/tmp", "/var/tmp", "/dev/shm", fmt.Sprintf("/run/user/%d", os.Getuid())}
	if temp := os.Getenv("TMPDIR"); filepath.IsAbs(temp) {
		roots = append(roots, filepath.Clean(temp))
	}
	return roots
}

var linuxEphemeralRoots = defaultLinuxEphemeralRoots

// checkStableLinuxExecutable refuses an executable that is gone after the
// next reboot or app exit: anything in an ephemeral root, and an AppImage's
// own runtime mount (a ".mount_XXXXXX" directory). Both the given path and
// its symlink target are checked, and a path that does not resolve is
// refused, since systemd would run whatever it later resolves to.
func checkStableLinuxExecutable(executable string) error {
	// systemd trims a condition's value, which would then guard another file.
	if strings.TrimSpace(executable) != executable {
		return fmt.Errorf("%w: %q has leading or trailing whitespace", ErrUnsupportedPath, executable)
	}
	// A trailing backslash continues the condition's line into the next one.
	if strings.HasSuffix(executable, `\`) {
		return fmt.Errorf("%w: %q ends in a backslash", ErrUnsupportedPath, executable)
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("%w: %q does not resolve: %v", ErrUnsupportedPath, executable, err)
	}
	for _, path := range []string{filepath.Clean(executable), resolved} {
		for _, root := range linuxEphemeralRoots() {
			if path == root || strings.HasPrefix(path, root+"/") {
				return fmt.Errorf("%w: %q is under %s", ErrUnsupportedPath, executable, root)
			}
		}
		for _, component := range strings.Split(path, "/") {
			if strings.HasPrefix(component, ".mount_") {
				return fmt.Errorf("%w: %q is inside a running AppImage's mount", ErrUnsupportedPath, executable)
			}
		}
	}
	return nil
}

func (s *systemd) path() string {
	configHome := s.spec.ConfigHome
	if configHome == "" {
		configHome = filepath.Join(s.spec.Home, ".config")
	}
	return filepath.Join(configHome, "systemd", "user", systemdUnit)
}

func (s *systemd) systemctl(ctx context.Context, args ...string) (string, error) {
	output, err := s.runner.Run(ctx, "systemctl", append([]string{"--user"}, args...)...)
	return strings.TrimSpace(string(output)), err
}

func (s *systemd) Install(ctx context.Context) error {
	wanted := renderUnit(s.spec)
	exists, owned, current, err := definitionState(s.path(), wanted)
	if err != nil {
		return err
	}
	if exists && !owned {
		return ErrForeignDefinition
	}
	if err := ensureLogDir(s.spec); err != nil {
		return err
	}
	if !current {
		if err := writeDefinition(s.path(), []byte(wanted), 0o644); err != nil {
			return err
		}
	}
	// Always reload: an earlier attempt may have written the file and then
	// failed before systemd read it.
	if _, err := s.systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	if exists && !current {
		if _, err := s.systemctl(ctx, "try-restart", systemdUnit); err != nil {
			return err
		}
	}
	_, err = s.systemctl(ctx, "enable", "--now", systemdUnit)
	return err
}

func (s *systemd) Uninstall(ctx context.Context) error {
	exists, owned, _, err := definitionState(s.path(), "")
	if err != nil || !exists {
		return err
	}
	if !owned {
		return ErrForeignDefinition
	}
	if _, err := s.systemctl(ctx, "disable", "--now", systemdUnit); err != nil {
		return err
	}
	if err := os.Remove(s.path()); err != nil {
		return err
	}
	_, err = s.systemctl(ctx, "daemon-reload")
	return err
}

func (s *systemd) Start(ctx context.Context) error {
	if exists, owned, _, err := definitionState(s.path(), ""); err != nil || !exists || !owned {
		if err != nil {
			return err
		}
		return ErrNotInstalled
	}
	_, err := s.systemctl(ctx, "start", systemdUnit)
	return err
}

func (s *systemd) Stop(ctx context.Context) error {
	exists, owned, _, err := definitionState(s.path(), "")
	if err != nil || !exists {
		return err
	}
	if !owned {
		return ErrForeignDefinition
	}
	_, err = s.systemctl(ctx, "stop", systemdUnit)
	return err
}

func (s *systemd) Status(ctx context.Context) (Status, error) {
	exists, owned, current, err := definitionState(s.path(), renderUnit(s.spec))
	if err != nil {
		return Status{}, err
	}
	status := Status{Backend: "systemd", Definition: s.path(), Installed: exists && owned, Current: current}
	// is-enabled and is-active exit non-zero for the negative answers.
	enabled, _ := s.systemctl(ctx, "is-enabled", systemdUnit)
	active, _ := s.systemctl(ctx, "is-active", systemdUnit)
	status.Enabled, status.Running = enabled == "enabled", active == "active"
	return status, nil
}

// systemdQuote quotes one ExecStart/Environment word: backslash and quote
// are escaped, and "%" and "$" are doubled so systemd does not expand them.
func systemdQuote(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$")
	return `"` + replacer.Replace(value) + `"`
}

// systemdConditionPath escapes only specifiers: a condition's value is the
// rest of the line, never unquoted, so ExecStart's quoting would become part
// of the path.
func systemdConditionPath(path string) string { return strings.ReplaceAll(path, "%", "%%") }

func renderUnit(spec Spec) string {
	var builder strings.Builder
	builder.WriteString("# " + ownershipMarker + "; changes are overwritten on install.\n")
	builder.WriteString("[Unit]\nDescription=Backplane companion\n")
	// A package removed without the app's Remove leaves this unit enabled;
	// the condition makes systemd skip the start instead of crash-looping.
	builder.WriteString("ConditionFileIsExecutable=" + systemdConditionPath(spec.Executable) + "\n")
	builder.WriteString("\n[Service]\nType=simple\n")
	builder.WriteString("ExecStart=" + systemdQuote(spec.Executable) + " run --log " + systemdQuote(spec.logPath()) + "\n")
	builder.WriteString("Restart=on-failure\nRestartSec=10\n")
	for _, key := range spec.sortedEnv() {
		builder.WriteString("Environment=" + systemdQuote(key+"="+spec.Env[key]) + "\n")
	}
	builder.WriteString("\n[Install]\nWantedBy=default.target\n")
	return builder.String()
}
