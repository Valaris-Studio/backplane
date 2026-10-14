// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package service registers the companion daemon (`run`) to start at login
// as a per-user background process: a launchd agent on macOS, a systemd user
// unit on Linux and a per-user Scheduled Task on Windows. Every OS tool call
// goes through a Runner so tests never touch the real service managers.
package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ownershipMarker identifies definitions this companion wrote; uninstall
// never removes a definition without it.
const ownershipMarker = "Managed by backplane-companion"

var (
	ErrUnsupportedPlatform = errors.New("service_unsupported_platform")
	ErrUnsupportedPath     = errors.New("service_unsupported_path")
	ErrForeignDefinition   = errors.New("service_definition_not_owned")
	ErrNotInstalled        = errors.New("service_not_installed")
)

type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

type Spec struct {
	Executable string
	DataDir    string
	Home       string
	// Env is passed through to the daemon, e.g. BACKPLANE_COMPANION_HOME.
	Env map[string]string
	// UID selects the launchd GUI domain.
	UID int
	// User is the Windows account (DOMAIN\name) the task runs as.
	User string
	// ConfigHome overrides ~/.config for systemd (XDG_CONFIG_HOME).
	ConfigHome string
	// IsRunning reports whether the daemon holds its lock. Scheduled Task
	// status uses it because schtasks' textual status output is localized.
	IsRunning func() bool
}

// logPath is the daemon's own size-capped log, written through `run --log`.
func (s Spec) logPath() string { return filepath.Join(s.DataDir, "logs", "companion.log") }

// stderrPath captures only what the daemon cannot log itself, e.g. a panic.
func (s Spec) stderrPath() string { return filepath.Join(s.DataDir, "logs", "stderr.log") }

func (s Spec) sortedEnv() []string {
	keys := make([]string, 0, len(s.Env))
	for key := range s.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type Status struct {
	Backend    string `json:"backend"`
	Definition string `json:"definition"`
	// Installed: our definition exists. Current: it matches what install
	// would write now (same executable, arguments and environment).
	Installed bool `json:"installed"`
	Current   bool `json:"current"`
	Enabled   bool `json:"enabled"`
	Running   bool `json:"running"`
}

type Manager interface {
	Install(context.Context) error
	Uninstall(context.Context) error
	Start(context.Context) error
	Stop(context.Context) error
	Status(context.Context) (Status, error)
}

var windowsAbsolute = regexp.MustCompile(`^([A-Za-z]:\\|\\\\)`)

// envKey is a POSIX environment name; with values free of NUL, CR and LF it
// cannot end a unit line, plist entry or task argument early.
var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func New(goos string, spec Spec, runner Runner) (Manager, error) {
	if goos != "darwin" && goos != "linux" && goos != "windows" {
		return nil, ErrUnsupportedPlatform
	}
	for _, path := range []string{spec.Executable, spec.DataDir} {
		absolute := filepath.IsAbs(path) || goos == "windows" && windowsAbsolute.MatchString(path)
		if !absolute || strings.ContainsAny(path, "\x00\r\n") {
			return nil, fmt.Errorf("%w: %q must be absolute", ErrUnsupportedPath, path)
		}
	}
	for key, value := range spec.Env {
		if !envKey.MatchString(key) || strings.ContainsAny(value, "\x00\r\n") {
			return nil, fmt.Errorf("%w: environment %q has an invalid name or a control character", ErrUnsupportedPath, key)
		}
	}
	if goos == "linux" {
		if err := checkStableLinuxExecutable(spec.Executable); err != nil {
			return nil, err
		}
	}
	if goos == "windows" {
		if err := validateTaskSpec(spec); err != nil {
			return nil, err
		}
	}
	switch goos {
	case "darwin":
		return &launchd{spec: spec, runner: runner}, nil
	case "linux":
		return &systemd{spec: spec, runner: runner}, nil
	default:
		return &scheduledTask{spec: spec, runner: runner}, nil
	}
}

// definitionState reads a definition file and reports whether it is ours
// and whether it already has the wanted content.
func definitionState(path, wanted string) (exists, owned, current bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, false, nil
	}
	if err != nil {
		return false, false, false, err
	}
	owned = bytes.Contains(data, []byte(ownershipMarker))
	return true, owned, owned && string(data) == wanted, nil
}

func writeDefinition(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".pending"
	if err := os.WriteFile(temporary, content, mode); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func ensureLogDir(spec Spec) error {
	return os.MkdirAll(filepath.Dir(spec.logPath()), 0o700)
}
