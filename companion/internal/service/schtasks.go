// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// ErrUnsupportedUser is a task account that is missing or cannot be written
// into the task safely.
var ErrUnsupportedUser = errors.New("service_unsupported_user")

// ErrDaemonStillRunning is a daemon that outlived the wait after its task
// was ended.
var ErrDaemonStillRunning = errors.New("service_daemon_still_running")

// daemonExitTimeout bounds the wait for an ended daemon to exit: it flushes
// nothing on TerminateProcess, so only handle teardown remains.
var daemonExitTimeout, daemonExitPoll = 15 * time.Second, 100 * time.Millisecond

// taskName lives in its own Task Scheduler folder so it never collides with
// another product's task.
const taskName = `\Backplane\Companion`

// scheduledTask runs the daemon as a per-user task at logon rather than a
// Windows service: a service runs under a service account and cannot read the
// user's Credential Manager, where the device token lives.
type scheduledTask struct {
	spec   Spec
	runner Runner
}

func (s *scheduledTask) path() string {
	return filepath.Join(s.spec.DataDir, "service", "companion-task.xml")
}

// owned reports whether a task with our name exists and carries our marker.
func (s *scheduledTask) owned(ctx context.Context) (exists, owned bool) {
	exists, owned, _ = s.query(ctx)
	return exists, owned
}

// query reads the exported task XML, which unlike schtasks' list output is
// not localized.
func (s *scheduledTask) query(ctx context.Context) (exists, owned bool, definition string) {
	output, err := s.runner.Run(ctx, "schtasks", "/Query", "/TN", taskName, "/XML", "ONE")
	if err != nil {
		return false, false, ""
	}
	return true, strings.Contains(string(output), ownershipMarker), string(output)
}

func (s *scheduledTask) Install(ctx context.Context) error {
	wanted := encodeUTF16(renderTask(s.spec))
	exists, owned := s.owned(ctx)
	if exists && !owned {
		return ErrForeignDefinition
	}
	stored, err := os.ReadFile(s.path())
	if exists && err == nil && string(stored) == string(wanted) {
		return nil
	}
	if err := ensureLogDir(s.spec); err != nil {
		return err
	}
	if err := writeDefinition(s.path(), wanted, 0o600); err != nil {
		return err
	}
	if _, err := s.runner.Run(ctx, "schtasks", "/Create", "/TN", taskName, "/XML", s.path(), "/F"); err != nil {
		return err
	}
	_, err = s.runner.Run(ctx, "schtasks", "/Run", "/TN", taskName)
	return err
}

func (s *scheduledTask) Uninstall(ctx context.Context) error {
	exists, owned := s.owned(ctx)
	if exists && !owned {
		return ErrForeignDefinition
	}
	var stopErr error
	if exists {
		stopErr = s.endDaemon(ctx)
		// Deleted even when the daemon outlives the wait, so it cannot
		// start again at the next logon.
		if _, err := s.runner.Run(ctx, "schtasks", "/Delete", "/TN", taskName, "/F"); err != nil {
			return withoutStillRunning(err, stopErr)
		}
	}
	if err := os.Remove(s.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return withoutStillRunning(err, stopErr)
	}
	return stopErr
}

// withoutStillRunning reports a teardown failure with the stop outcome as
// text only: callers carry on past ErrDaemonStillRunning, and a task that
// was not deleted must stop them.
func withoutStillRunning(err, stopErr error) error {
	if stopErr == nil {
		return err
	}
	return fmt.Errorf("%w (and %v)", err, stopErr)
}

func (s *scheduledTask) Start(ctx context.Context) error {
	if _, owned := s.owned(ctx); !owned {
		return ErrNotInstalled
	}
	_, err := s.runner.Run(ctx, "schtasks", "/Run", "/TN", taskName)
	return err
}

func (s *scheduledTask) Stop(ctx context.Context) error {
	exists, owned := s.owned(ctx)
	if !exists {
		return nil
	}
	if !owned {
		return ErrForeignDefinition
	}
	return s.endDaemon(ctx)
}

// endDaemon ends the task and waits for the daemon to exit. /End returns
// once TerminateProcess is issued, before Windows closes the process's
// files (its log, the data directory's locks), so a caller that deletes
// them right away fails. /End also fails for a task that is not running;
// whether the daemon is gone decides, not its answer.
func (s *scheduledTask) endDaemon(ctx context.Context) error {
	_, endErr := s.runner.Run(ctx, "schtasks", "/End", "/TN", taskName)
	if s.spec.IsRunning == nil {
		return endErr
	}
	deadline := time.Now().Add(daemonExitTimeout)
	for s.spec.IsRunning() {
		if time.Now().After(deadline) {
			return errors.Join(ErrDaemonStillRunning, endErr)
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), endErr)
		case <-time.After(daemonExitPoll):
		}
	}
	return nil
}

func (s *scheduledTask) Status(ctx context.Context) (Status, error) {
	status := Status{Backend: "scheduled_task", Definition: taskName}
	_, owned, definition := s.query(ctx)
	status.Installed = owned
	if !owned {
		return status, nil
	}
	stored, err := os.ReadFile(s.path())
	status.Current = err == nil && string(stored) == string(encodeUTF16(renderTask(s.spec)))
	status.Enabled = taskEnabled(definition)
	status.Running = s.spec.IsRunning != nil && s.spec.IsRunning()
	return status, nil
}

// taskEnabled reads the task-level <Settings><Enabled>, which defaults to
// true when the export omits it.
func taskEnabled(definition string) bool {
	start := strings.Index(definition, "<Settings>")
	end := strings.Index(definition, "</Settings>")
	if start < 0 || end < start {
		return true
	}
	return !strings.Contains(definition[start:end], "<Enabled>false</Enabled>")
}

// validateTaskSpec refuses what the task definition cannot carry safely.
// Arguments are double-quoted and Task Scheduler expands %VARIABLE% in them,
// so neither character can be passed; a trailing backslash would escape the
// closing quote; control characters have no place in a path or account.
// The account must be named, because a logon trigger without one fires for
// every user who logs on.
func validateTaskSpec(spec Spec) error {
	for _, value := range []string{spec.Executable, spec.DataDir, spec.Env["BACKPLANE_BEACON_ARTIFACT"], spec.Env["BACKPLANE_OTELCOL_ARTIFACT"]} {
		if strings.ContainsAny(value, `"%`) || strings.HasSuffix(value, `\`) || hasControlCharacter(value) {
			return fmt.Errorf("%w: %q cannot be passed to a scheduled task", ErrUnsupportedPath, value)
		}
	}
	if strings.TrimSpace(spec.User) == "" || strings.ContainsAny(spec.User, `"%`) || hasControlCharacter(spec.User) {
		return fmt.Errorf("%w: %q", ErrUnsupportedUser, spec.User)
	}
	return nil
}

func hasControlCharacter(value string) bool {
	return strings.ContainsFunc(value, unicode.IsControl)
}

// windowsPath joins with backslashes regardless of the OS rendering it.
func windowsPath(base string, parts ...string) string {
	return strings.TrimRight(base, `\/`) + `\` + strings.Join(parts, `\`)
}

// renderTask passes the data directory as an argument because Task Scheduler
// actions cannot set environment variables. RestartOnFailure covers a failed
// launch, not necessarily a crash of the running daemon (CR-9 qualifies it).
func renderTask(spec Spec) string {
	arguments := `run --data-dir "` + spec.DataDir + `" --log "` + windowsPath(spec.DataDir, "logs", "companion.log") + `"`
	if artifact := spec.Env["BACKPLANE_BEACON_ARTIFACT"]; artifact != "" {
		arguments += ` --beacon-artifact "` + artifact + `"`
	}
	if artifact := spec.Env["BACKPLANE_OTELCOL_ARTIFACT"]; artifact != "" {
		arguments += ` --otelcol-artifact "` + artifact + `"`
	}
	user := xmlText(spec.User)
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>` + ownershipMarker + `</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>` + user + `</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>` + user + `</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlText(spec.Executable) + `</Command>
      <Arguments>` + xmlText(arguments) + `</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

// encodeUTF16 produces UTF-16LE with a byte-order mark, the encoding the
// XML declaration names and schtasks /XML expects.
func encodeUTF16(text string) []byte {
	units := utf16.Encode([]rune(text))
	encoded := make([]byte, 2+2*len(units))
	encoded[0], encoded[1] = 0xFF, 0xFE
	for index, unit := range units {
		encoded[2+2*index] = byte(unit)
		encoded[3+2*index] = byte(unit >> 8)
	}
	return encoded
}
