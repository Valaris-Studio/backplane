// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func withEphemeralRoots(t *testing.T, roots ...string) {
	t.Helper()
	real := linuxEphemeralRoots
	linuxEphemeralRoots = func() []string { return roots }
	t.Cleanup(func() { linuxEphemeralRoots = real })
}

func executableFile(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSystemd_InstallWritesOwnedUnit(t *testing.T) {
	spec := testSpec(t)
	spec.ConfigHome = filepath.Join(spec.Home, "xdg-config")
	spec.Env = map[string]string{
		"BACKPLANE_OTELCOL_ARTIFACT": "/opt/backplane/otelcol.json",
		"BACKPLANE_COMPANION_HOME":   spec.DataDir,
		"BACKPLANE_BEACON_ARTIFACT":  "/opt/backplane/beacon.json",
	}
	manager, err := New("linux", spec, &fakeRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	unitPath := filepath.Join(spec.ConfigHome, "systemd", "user", systemdUnit)
	info, err := os.Stat(unitPath)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("unit %s: %v %v", unitPath, info, err)
	}
	data, _ := os.ReadFile(unitPath)
	unit := string(data)
	if !strings.HasPrefix(unit, "# "+ownershipMarker) {
		t.Fatalf("unit does not start with the ownership marker:\n%s", unit)
	}
	beacon := strings.Index(unit, `Environment="BACKPLANE_BEACON_ARTIFACT=/opt/backplane/beacon.json"`)
	home := strings.Index(unit, `Environment="BACKPLANE_COMPANION_HOME=`+spec.DataDir+`"`)
	otelcol := strings.Index(unit, `Environment="BACKPLANE_OTELCOL_ARTIFACT=/opt/backplane/otelcol.json"`)
	if beacon < 0 || home < beacon || otelcol < home {
		t.Fatalf("environment not passed through in sorted order:\n%s", unit)
	}
	if strings.Count(unit, "Environment=") != len(spec.Env) {
		t.Fatalf("unexpected environment lines:\n%s", unit)
	}
}

func TestSystemd_RejectsAppImageMountExecutable(t *testing.T) {
	spec := testSpec(t)
	linuxEphemeralRoots = defaultLinuxEphemeralRoots
	t.Setenv("TMPDIR", "/scratch/me-tmp")
	for _, executable := range []string{
		"/tmp/.mount_BackplZ1x9Qa/usr/bin/backplane-companion",
		"/home/me/.cache/tmp/.mount_Backpl0000/usr/bin/backplane-companion",
		"/tmp/backplane-companion",
		"/tmp/unpacked/bin/backplane-companion",
		"/var/tmp/backplane-companion",
		"/dev/shm/backplane-companion",
		fmt.Sprintf("/run/user/%d/backplane-companion", os.Getuid()),
		"/scratch/me-tmp/backplane-companion",
		"/tmp/../tmp/backplane-companion",
	} {
		spec.Executable = executable
		if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("linux service accepted executable %q: %v", executable, err)
		}
	}
}

func TestSystemd_RejectsAStableLookingSymlinkIntoAnEphemeralRoot(t *testing.T) {
	spec := testSpec(t)
	root := t.TempDir()
	ephemeral := filepath.Join(root, "tmp")
	target := executableFile(t, filepath.Join(ephemeral, "unpacked", "backplane-companion"))
	link := filepath.Join(root, "usr", "lib", "backplane-companion", "backplane-companion")
	os.MkdirAll(filepath.Dir(link), 0o700)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	resolvedEphemeral, _ := filepath.EvalSymlinks(ephemeral)
	withEphemeralRoots(t, resolvedEphemeral)
	spec.Executable = link
	if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
		t.Fatalf("symlink into an ephemeral root accepted: %v", err)
	}
}

func TestSystemd_RejectsAnUnresolvableExecutable(t *testing.T) {
	spec := testSpec(t)
	missing := filepath.Join(t.TempDir(), "usr", "lib", "backplane-companion", "missing")
	dangling := filepath.Join(t.TempDir(), "dangling")
	if err := os.Symlink(missing, dangling); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{missing, dangling} {
		spec.Executable = executable
		if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("unresolvable executable %q accepted: %v", executable, err)
		}
	}
}

func TestSystemd_AcceptsAStableExecutable(t *testing.T) {
	spec := testSpec(t)
	root := t.TempDir()
	withEphemeralRoots(t, filepath.Join(root, "tmp"), filepath.Join(root, "var", "tmp"))
	for _, relative := range []string{
		"usr/lib/backplane-companion/backplane-companion",
		"home/me/.local/lib/backplane-companion/backplane-companion",
		"opt/.mountain/backplane-companion",
		"tmpfs-backed/backplane-companion",
	} {
		spec.Executable = executableFile(t, filepath.Join(root, relative))
		if _, err := New("linux", spec, &fakeRunner{}); err != nil {
			t.Errorf("linux service refused executable %q: %v", spec.Executable, err)
		}
	}
}

func TestLaunchd_TmpExecutableRuleIsLinuxOnly(t *testing.T) {
	spec := testSpec(t)
	spec.Executable = "/tmp/backplane-companion"
	if _, err := New("darwin", spec, &fakeRunner{}); err != nil {
		t.Fatalf("darwin refused %q: %v", spec.Executable, err)
	}
}

func TestSystemd_EnvCannotInjectUnitDirectives(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"newline in value":         {"BACKPLANE_COMPANION_HOME": "x\nExecStartPre=/tmp/evil\n#"},
		"carriage return in value": {"BACKPLANE_COMPANION_HOME": "x\rExecStartPre=/tmp/evil"},
		"NUL in value":             {"BACKPLANE_COMPANION_HOME": "x\x00y"},
		"newline in key":           {"A\nExecStartPre=/tmp/evil": "x"},
		"equals in key":            {"A=B": "x"},
		"space in key":             {"A B": "x"},
		"leading digit in key":     {"1A": "x"},
		"empty key":                {"": "x"},
	} {
		spec := testSpec(t)
		spec.Env = env
		if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("%s: accepted %q: %v", name, env, err)
		}
	}
}

func TestLaunchd_EnvCannotInjectPlistEntries(t *testing.T) {
	spec := testSpec(t)
	spec.Env = map[string]string{"BACKPLANE_COMPANION_HOME": "x\n</string><key>ProgramArguments</key>"}
	if _, err := New("darwin", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
		t.Fatalf("darwin accepted a newline in an env value: %v", err)
	}
	spec.Env = map[string]string{"BAD KEY": "x"}
	if _, err := New("darwin", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
		t.Fatalf("darwin accepted an invalid env key: %v", err)
	}
}

func TestNew_AcceptsOrdinaryEnv(t *testing.T) {
	spec := testSpec(t)
	spec.Env = map[string]string{"BACKPLANE_COMPANION_HOME": spec.DataDir, "_Mixed_9": "a b=c %$\"'"}
	for _, goos := range []string{"darwin", "linux"} {
		if _, err := New(goos, spec, &fakeRunner{}); err != nil {
			t.Errorf("%s refused ordinary env: %v", goos, err)
		}
	}
}

// unitSection returns the lines of one [Section] of a rendered unit.
func unitSection(unit, name string) []string {
	var lines []string
	inside := false
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "[") {
			inside = line == "["+name+"]"
			continue
		}
		if inside && line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func TestSystemdUnit_SkipsTheStartWhenItsExecutableIsGone(t *testing.T) {
	spec := testSpec(t)
	spec.Executable = "/usr/lib/backplane-companion/backplane-companion"
	want := "ConditionFileIsExecutable=/usr/lib/backplane-companion/backplane-companion"
	if lines := unitSection(renderUnit(spec), "Unit"); !slices.Contains(lines, want) {
		t.Fatalf("[Unit] lacks %q: %q", want, lines)
	}
	execStart := `ExecStart="/usr/lib/backplane-companion/backplane-companion" run`
	if !strings.Contains(renderUnit(spec), execStart) {
		t.Fatalf("condition and ExecStart name different executables:\n%s", renderUnit(spec))
	}
}

// Condition paths are not unquoted: systemd takes the rest of the line
// after specifier expansion, so only "%" is escaped and a quote would
// become part of the path (a relative, ignored one).
func TestSystemdUnit_ConditionPathIsTheLiteralExecutableWithSpecifiersEscaped(t *testing.T) {
	spec := testSpec(t)
	spec.Executable = `/opt/Back plane/100%$dir/"x"\y/backplane-companion`
	unit := renderUnit(spec)
	want := `ConditionFileIsExecutable=/opt/Back plane/100%%$dir/"x"\y/backplane-companion`
	if !slices.Contains(unitSection(unit, "Unit"), want) {
		t.Fatalf("[Unit] lacks %q:\n%s", want, unit)
	}
	if !strings.Contains(unit, `ExecStart="/opt/Back plane/100%%$$dir/\"x\"\\y/backplane-companion" run`) {
		t.Fatalf("ExecStart quoting changed:\n%s", unit)
	}
	if strings.Count(unit, "ConditionFileIsExecutable=") != 1 {
		t.Fatalf("want exactly one executable condition:\n%s", unit)
	}
}

// systemd trims a condition's value, so a path with outer whitespace would
// guard a different file than ExecStart runs.
func TestSystemd_RejectsAnExecutableWithOuterWhitespace(t *testing.T) {
	spec := testSpec(t)
	for _, executable := range []string{spec.Executable + " ", spec.Executable + "\t"} {
		executableFile(t, executable)
		spec.Executable = executable
		if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("linux service accepted %q: %v", executable, err)
		}
	}
}

func TestSystemd_InstallRefreshesAUnitWrittenWithoutTheCondition(t *testing.T) {
	spec := testSpec(t)
	spec.ConfigHome = filepath.Join(spec.Home, "xdg-config")
	unitPath := filepath.Join(spec.ConfigHome, "systemd", "user", systemdUnit)
	legacy := strings.Replace(renderUnit(spec), "ConditionFileIsExecutable="+spec.Executable+"\n", "", 1)
	if legacy == renderUnit(spec) {
		t.Fatal("fixture still carries the condition")
	}
	os.MkdirAll(filepath.Dir(unitPath), 0o700)
	if err := os.WriteFile(unitPath, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	manager, err := New("linux", spec, runner)
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := manager.Status(context.Background()); !status.Installed || status.Current {
		t.Fatalf("a unit without the condition must read as installed but stale: %+v", status)
	}
	if err := manager.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(unitPath); string(data) != renderUnit(spec) {
		t.Fatalf("unit not refreshed:\n%s", data)
	}
	if runner.ran("systemctl --user try-restart "+systemdUnit) != 1 || runner.ran("systemctl --user enable --now "+systemdUnit) != 1 {
		t.Fatalf("refresh must restart and enable: %v", runner.calls)
	}
}

// A trailing backslash continues a unit-file line, so the condition would
// swallow the line after it.
func TestSystemd_RejectsAnExecutableEndingInABackslash(t *testing.T) {
	spec := testSpec(t)
	spec.Executable = executableFile(t, spec.Executable+`\`)
	if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
		t.Fatalf("linux service accepted %q: %v", spec.Executable, err)
	}
}
