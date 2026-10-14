// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

type call []string

type fakeRunner struct {
	calls []call
	// respond returns output and error for a command line; nil means success.
	respond func(command string) (string, error)
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append(call{name}, args...))
	if f.respond == nil {
		return nil, nil
	}
	output, err := f.respond(strings.Join(append([]string{name}, args...), " "))
	return []byte(output), err
}

func (f *fakeRunner) ran(prefix string) int {
	count := 0
	for _, c := range f.calls {
		if strings.HasPrefix(strings.Join(c, " "), prefix) {
			count++
		}
	}
	return count
}

var errExit = errors.New("exit status 1")

func testSpec(t *testing.T) Spec {
	t.Helper()
	root := t.TempDir()
	// t.TempDir() is itself an ephemeral root (/tmp, $TMPDIR); tests that
	// check the roots set them back.
	withEphemeralRoots(t)
	return Spec{
		Executable: executableFile(t, filepath.Join(root, "opt", "backplane", "bin", "backplane companion")),
		DataDir:    filepath.Join(root, "data"),
		Home:       filepath.Join(root, "home"),
		Env:        map[string]string{"BACKPLANE_COMPANION_HOME": filepath.Join(root, "data")},
		UID:        501,
		User:       `HOST\person`,
	}
}

func TestLaunchdPlistContent(t *testing.T) {
	spec := testSpec(t)
	plist := renderPlist(spec)
	for _, want := range []string{
		"<string>" + launchdLabel + "</string>",
		"<string>" + spec.Executable + "</string>\n\t\t<string>run</string>\n\t\t<string>--log</string>\n\t\t<string>" + filepath.Join(spec.DataDir, "logs", "companion.log") + "</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>SuccessfulExit</key>\n\t\t<false/>",
		"<key>StandardErrorPath</key>\n\t<string>" + filepath.Join(spec.DataDir, "logs", "stderr.log") + "</string>",
		"<key>BACKPLANE_COMPANION_HOME</key>\n\t\t<string>" + spec.DataDir + "</string>",
		ownershipMarker,
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist missing %q:\n%s", want, plist)
		}
	}
	spec.Executable = "/Apps/a&b<c>/backplane-companion"
	spec.Env = nil
	escaped := renderPlist(spec)
	if !strings.Contains(escaped, "a&amp;b&lt;c&gt;") || strings.Contains(escaped, "EnvironmentVariables") {
		t.Fatalf("plist not escaped or env not omitted:\n%s", escaped)
	}
}

func TestSystemdUnitContent(t *testing.T) {
	spec := testSpec(t)
	unit := renderUnit(spec)
	for _, want := range []string{
		ownershipMarker,
		`ExecStart="` + spec.Executable + `" run --log "` + filepath.Join(spec.DataDir, "logs", "companion.log") + `"`,
		"Restart=on-failure",
		`Environment="BACKPLANE_COMPANION_HOME=` + spec.DataDir + `"`,
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing %q:\n%s", want, unit)
		}
	}
	spec.Executable = `/opt/100%$dir/"x"/backplane-companion`
	spec.DataDir = "/data/50%"
	spec.Env = map[string]string{"BACKPLANE_COMPANION_HOME": "/data/50%"}
	tricky := renderUnit(spec)
	for _, want := range []string{
		`ExecStart="/opt/100%%$$dir/\"x\"/backplane-companion" run --log "/data/50%%/logs/companion.log"`,
		`Environment="BACKPLANE_COMPANION_HOME=/data/50%%"`,
	} {
		if !strings.Contains(tricky, want) {
			t.Fatalf("systemd specifiers not escaped, want %s:\n%s", want, tricky)
		}
	}
	if strings.Contains(tricky, "StandardOutput") {
		t.Fatal("stdout should go to the journal; the daemon writes its own capped log")
	}
}

func TestScheduledTaskContent(t *testing.T) {
	spec := testSpec(t)
	spec.Executable = `C:\Program Files\Backplane\backplane-companion.exe`
	spec.DataDir = `C:\Users\person\AppData\Local\Backplane\Companion`
	task := renderTask(spec)
	for _, want := range []string{
		ownershipMarker,
		"<Command>" + spec.Executable + "</Command>",
		`<Arguments>run --data-dir "` + spec.DataDir + `" --log "` + spec.DataDir + `\logs\companion.log"</Arguments>`,
		"<RestartOnFailure>",
		"<LogonType>InteractiveToken</LogonType>",
		`<UserId>HOST\person</UserId>`,
		"<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
	} {
		if !strings.Contains(task, want) {
			t.Errorf("task missing %q:\n%s", want, task)
		}
	}
	encoded := encodeUTF16(task)
	if encoded[0] != 0xFF || encoded[1] != 0xFE {
		t.Fatal("task XML must be UTF-16LE with a byte-order mark for schtasks")
	}
	units := make([]uint16, (len(encoded)-2)/2)
	for i := range units {
		units[i] = uint16(encoded[2+2*i]) | uint16(encoded[3+2*i])<<8
	}
	if string(utf16.Decode(units)) != task {
		t.Fatal("UTF-16 round trip failed")
	}
	for name, mutate := range map[string]func(*Spec){
		"quote in data dir":     func(s *Spec) { s.DataDir = `C:\bad"dir` },
		"percent in data dir":   func(s *Spec) { s.DataDir = `C:\100%USERNAME%` },
		"percent in executable": func(s *Spec) { s.Executable = `C:\%TEMP%\backplane-companion.exe` },
		"quote in artifact":     func(s *Spec) { s.Env = map[string]string{"BACKPLANE_BEACON_ARTIFACT": `C:\a"b\artifact.json`} },
		"percent in artifact":   func(s *Spec) { s.Env = map[string]string{"BACKPLANE_BEACON_ARTIFACT": `C:\%X%\artifact.json`} },
	} {
		bad := spec
		mutate(&bad)
		if _, err := New("windows", bad, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

func TestNewValidatesSpecAndPlatform(t *testing.T) {
	spec := testSpec(t)
	if _, err := New("plan9", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatal("unsupported platform accepted")
	}
	spec.Executable = "backplane-companion"
	if _, err := New("linux", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
		t.Fatal("relative executable accepted")
	}
}

func TestLaunchdLifecycle(t *testing.T) {
	spec := testSpec(t)
	registered := false
	runner := &fakeRunner{respond: func(command string) (string, error) {
		switch {
		case strings.HasPrefix(command, "launchctl print"):
			if !registered {
				return "", errExit
			}
			return "state = running", nil
		case strings.HasPrefix(command, "launchctl bootstrap"):
			registered = true
		case strings.HasPrefix(command, "launchctl bootout"):
			registered = false
		}
		return "", nil
	}}
	manager, _ := New("darwin", spec, runner)
	ctx := context.Background()
	if err := manager.Install(ctx); err != nil {
		t.Fatal(err)
	}
	plistPath := filepath.Join(spec.Home, "Library", "LaunchAgents", launchdLabel+".plist")
	if data, err := os.ReadFile(plistPath); err != nil || string(data) != renderPlist(spec) {
		t.Fatalf("plist not written: %v", err)
	}
	if runner.ran("launchctl bootstrap gui/501 "+plistPath) != 1 {
		t.Fatalf("not bootstrapped: %v", runner.calls)
	}
	if err := manager.Install(ctx); err != nil || runner.ran("launchctl bootstrap") != 1 || runner.ran("launchctl bootout") != 0 {
		t.Fatalf("reinstall not idempotent: %v", runner.calls)
	}
	status, err := manager.Status(ctx)
	if err != nil || !status.Installed || !status.Current || !status.Enabled || !status.Running || status.Backend != "launchd" {
		t.Fatalf("status: %+v %v", status, err)
	}
	if err := manager.Start(ctx); err != nil || runner.ran("launchctl kickstart gui/501/"+launchdLabel) != 1 {
		t.Fatalf("start: %v", runner.calls)
	}
	if err := manager.Stop(ctx); err != nil || runner.ran("launchctl kill SIGTERM gui/501/"+launchdLabel) != 1 {
		t.Fatalf("stop: %v", runner.calls)
	}
	changed := spec
	changed.Env = nil
	manager, _ = New("darwin", changed, runner)
	if err := manager.Install(ctx); err != nil || runner.ran("launchctl bootout") != 1 || runner.ran("launchctl bootstrap") != 2 {
		t.Fatalf("changed definition not reloaded: %v", runner.calls)
	}
	if err := manager.Uninstall(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plistPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("plist left after uninstall")
	}
	if err := manager.Uninstall(ctx); err != nil {
		t.Fatal("uninstall must be idempotent")
	}
}

func TestUninstallLeavesForeignDefinitions(t *testing.T) {
	spec := testSpec(t)
	plistPath := filepath.Join(spec.Home, "Library", "LaunchAgents", launchdLabel+".plist")
	os.MkdirAll(filepath.Dir(plistPath), 0o700)
	os.WriteFile(plistPath, []byte("<plist>someone else's</plist>"), 0o644)
	runner := &fakeRunner{}
	manager, _ := New("darwin", spec, runner)
	if err := manager.Uninstall(context.Background()); !errors.Is(err, ErrForeignDefinition) {
		t.Fatalf("foreign plist: %v", err)
	}
	if data, _ := os.ReadFile(plistPath); string(data) != "<plist>someone else's</plist>" {
		t.Fatal("foreign plist changed")
	}
	if err := manager.Install(context.Background()); !errors.Is(err, ErrForeignDefinition) {
		t.Fatalf("install overwrote a foreign plist: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("ran commands against a foreign definition: %v", runner.calls)
	}
}

func TestSystemdLifecycle(t *testing.T) {
	spec := testSpec(t)
	spec.ConfigHome = filepath.Join(spec.Home, "xdg-config")
	runner := &fakeRunner{respond: func(command string) (string, error) {
		switch {
		case strings.Contains(command, "is-enabled"):
			return "enabled\n", nil
		case strings.Contains(command, "is-active"):
			return "inactive\n", errExit
		}
		return "", nil
	}}
	manager, _ := New("linux", spec, runner)
	ctx := context.Background()
	if err := manager.Install(ctx); err != nil {
		t.Fatal(err)
	}
	unitPath := filepath.Join(spec.ConfigHome, "systemd", "user", systemdUnit)
	if data, err := os.ReadFile(unitPath); err != nil || string(data) != renderUnit(spec) {
		t.Fatalf("unit not written: %v", err)
	}
	if runner.ran("systemctl --user daemon-reload") != 1 || runner.ran("systemctl --user enable --now "+systemdUnit) != 1 {
		t.Fatalf("unit not enabled: %v", runner.calls)
	}
	// Reload every time: a previous attempt may have written the file but
	// failed before systemd picked it up.
	if err := manager.Install(ctx); err != nil || runner.ran("systemctl --user daemon-reload") != 2 || runner.ran("systemctl --user try-restart") != 0 {
		t.Fatalf("reinstall must reload but not restart an unchanged unit: %v", runner.calls)
	}
	status, _ := manager.Status(ctx)
	if !status.Installed || !status.Current || !status.Enabled || status.Running {
		t.Fatalf("status: %+v", status)
	}
	manager.Start(ctx)
	manager.Stop(ctx)
	if runner.ran("systemctl --user start "+systemdUnit) != 1 || runner.ran("systemctl --user stop "+systemdUnit) != 1 {
		t.Fatalf("start/stop: %v", runner.calls)
	}
	if err := manager.Uninstall(ctx); err != nil || runner.ran("systemctl --user disable --now "+systemdUnit) != 1 {
		t.Fatalf("uninstall: %v %v", err, runner.calls)
	}
	if _, err := os.Stat(unitPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unit left after uninstall")
	}
}

func TestScheduledTaskLifecycle(t *testing.T) {
	spec := testSpec(t)
	daemonRunning := true
	spec.IsRunning = func() bool { return daemonRunning }
	installed, taskEnabled := false, "true"
	runner := &fakeRunner{respond: func(command string) (string, error) {
		switch {
		case strings.HasPrefix(command, "schtasks /Query /TN "+taskName+" /XML"):
			if !installed {
				return "", errExit
			}
			return "<Description>" + ownershipMarker + "</Description><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>" + taskEnabled + "</Enabled></Settings>", nil
		case strings.Contains(command, "/FO"):
			t.Fatalf("localized list output must not be parsed: %s", command)
		case strings.HasPrefix(command, "schtasks /Create"):
			installed = true
		case strings.HasPrefix(command, "schtasks /Delete"):
			installed = false
		}
		return "", nil
	}}
	manager, _ := New("windows", spec, runner)
	ctx := context.Background()
	if err := manager.Install(ctx); err != nil {
		t.Fatal(err)
	}
	taskFile := filepath.Join(spec.DataDir, "service", "companion-task.xml")
	if runner.ran("schtasks /Create /TN "+taskName+" /XML "+taskFile+" /F") != 1 || runner.ran("schtasks /Run /TN "+taskName) != 1 {
		t.Fatalf("task not created and started: %v", runner.calls)
	}
	if err := manager.Install(ctx); err != nil || runner.ran("schtasks /Create") != 1 {
		t.Fatalf("reinstall not idempotent: %v", runner.calls)
	}
	status, _ := manager.Status(ctx)
	if !status.Installed || !status.Current || !status.Running || !status.Enabled || status.Backend != "scheduled_task" {
		t.Fatalf("status: %+v", status)
	}
	daemonRunning, taskEnabled = false, "false"
	if status, _ := manager.Status(ctx); status.Running || status.Enabled {
		t.Fatalf("running must follow the daemon lock and enabled the task XML: %+v", status)
	}
	manager.Stop(ctx)
	if runner.ran("schtasks /End /TN "+taskName) != 1 {
		t.Fatalf("stop: %v", runner.calls)
	}
	if err := manager.Uninstall(ctx); err != nil || runner.ran("schtasks /Delete /TN "+taskName+" /F") != 1 {
		t.Fatalf("uninstall: %v %v", err, runner.calls)
	}
	if _, err := os.Stat(taskFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("task file left after uninstall")
	}
}

func TestScheduledTaskUninstallLeavesForeignTask(t *testing.T) {
	spec := testSpec(t)
	runner := &fakeRunner{respond: func(command string) (string, error) {
		if strings.Contains(command, "/XML") {
			return "<Description>not ours</Description>", nil
		}
		return "", nil
	}}
	manager, _ := New("windows", spec, runner)
	if err := manager.Uninstall(context.Background()); !errors.Is(err, ErrForeignDefinition) {
		t.Fatalf("foreign task: %v", err)
	}
	if runner.ran("schtasks /Delete") != 0 || runner.ran("schtasks /End") != 0 {
		t.Fatal("touched a foreign task")
	}
}

func TestStartBeforeInstallIsAnError(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		runner := &fakeRunner{respond: func(string) (string, error) { return "", errExit }}
		manager, _ := New(goos, testSpec(t), runner)
		if err := manager.Start(context.Background()); !errors.Is(err, ErrNotInstalled) {
			t.Errorf("%s: start before install: %v", goos, err)
		}
	}
}

func TestStopLeavesForeignDefinitionsAlone(t *testing.T) {
	spec := testSpec(t)
	spec.ConfigHome = filepath.Join(spec.Home, ".config")
	plist := filepath.Join(spec.Home, "Library", "LaunchAgents", launchdLabel+".plist")
	unit := filepath.Join(spec.ConfigHome, "systemd", "user", systemdUnit)
	for _, path := range []string{plist, unit} {
		os.MkdirAll(filepath.Dir(path), 0o700)
		os.WriteFile(path, []byte("someone else's"), 0o644)
	}
	for _, goos := range []string{"darwin", "linux", "windows"} {
		runner := &fakeRunner{respond: func(command string) (string, error) {
			if strings.Contains(command, "/XML") {
				return "<Description>not ours</Description>", nil
			}
			return "state = running", nil
		}}
		manager, _ := New(goos, spec, runner)
		if err := manager.Stop(context.Background()); !errors.Is(err, ErrForeignDefinition) {
			t.Errorf("%s: stop on a foreign definition: %v", goos, err)
		}
		for _, c := range runner.calls {
			command := strings.Join(c, " ")
			if strings.Contains(command, "kill") || strings.Contains(command, " stop ") || strings.Contains(command, "/End") {
				t.Errorf("%s: stopped a foreign service: %s", goos, command)
			}
		}
	}
}

// launchd loads a per-user agent owned by the user at 0600; the plist carries
// the data directory path, so nobody else needs to read it.
func TestLaunchdInstall_WritesAnOwnerOnlyPlist(t *testing.T) {
	spec := testSpec(t)
	manager, _ := New("darwin", spec, &fakeRunner{respond: func(command string) (string, error) {
		if strings.HasPrefix(command, "launchctl print") {
			return "", errExit
		}
		return "", nil
	}})
	if err := manager.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(spec.Home, "Library", "LaunchAgents", launchdLabel+".plist"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("plist mode %v, want 0600: %v", info.Mode().Perm(), err)
	}
}

func TestLaunchdInstall_TightensACurrentPlistWithoutReloading(t *testing.T) {
	spec := testSpec(t)
	plistPath := filepath.Join(spec.Home, "Library", "LaunchAgents", launchdLabel+".plist")
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, []byte(renderPlist(spec)), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Chmod(plistPath, 0o644)
	runner := &fakeRunner{respond: func(command string) (string, error) {
		if strings.HasPrefix(command, "launchctl print") {
			return "state = running", nil
		}
		return "", nil
	}}
	manager, _ := New("darwin", spec, runner)
	if err := manager.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(plistPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("current plist mode %v, want 0600: %v", info.Mode().Perm(), err)
	}
	if runner.ran("launchctl bootout") != 0 || runner.ran("launchctl bootstrap") != 0 {
		t.Fatalf("a current, registered agent was reloaded: %v", runner.calls)
	}
}

func windowsTaskSpec(t *testing.T) Spec {
	spec := testSpec(t)
	spec.Executable = `C:\Users\person\AppData\Local\Programs\Backplane Companion\backplane-companiond.exe`
	spec.DataDir = `C:\Users\person\AppData\Local\Backplane\Companion`
	return spec
}

func TestRenderTask_UsesWindowlessDaemon(t *testing.T) {
	spec := windowsTaskSpec(t)
	task := renderTask(spec)
	if !strings.Contains(task, "<Command>"+spec.Executable+"</Command>") {
		t.Fatalf("task does not run the windowless daemon directly:\n%s", task)
	}
	for _, wrapper := range []string{"cmd.exe", "powershell", "conhost", "wscript"} {
		if strings.Contains(strings.ToLower(task), wrapper) {
			t.Fatalf("task wraps the daemon in %s:\n%s", wrapper, task)
		}
	}
}

func TestRenderTask_TriggersOnlyForTheCurrentUser(t *testing.T) {
	task := renderTask(windowsTaskSpec(t))
	trigger := task[strings.Index(task, "<LogonTrigger>"):strings.Index(task, "</LogonTrigger>")]
	principal := task[strings.Index(task, "<Principal "):strings.Index(task, "</Principal>")]
	for name, section := range map[string]string{"logon trigger": trigger, "principal": principal} {
		if !strings.Contains(section, `<UserId>HOST\person</UserId>`) {
			t.Errorf("%s is not bound to the user:\n%s", name, section)
		}
	}
	if strings.Contains(task, "HighestAvailable") || strings.Contains(task, "S4U") || strings.Contains(task, "Password") {
		t.Fatalf("task runs elevated or without the user's session:\n%s", task)
	}
}

func TestRenderTask_RejectsPercentAndQuote(t *testing.T) {
	spec := windowsTaskSpec(t)
	if _, err := New("windows", spec, &fakeRunner{}); err != nil {
		t.Fatalf("valid spec refused: %v", err)
	}
	for name, mutate := range map[string]func(*Spec){
		"quote in data dir":        func(s *Spec) { s.DataDir = `C:\bad"dir` },
		"percent in data dir":      func(s *Spec) { s.DataDir = `C:\100%USERNAME%` },
		"percent in executable":    func(s *Spec) { s.Executable = `C:\%TEMP%\backplane-companiond.exe` },
		"quote in artifact":        func(s *Spec) { s.Env = map[string]string{"BACKPLANE_BEACON_ARTIFACT": `C:\a"b\artifact.json`} },
		"percent in otel artifact": func(s *Spec) { s.Env = map[string]string{"BACKPLANE_OTELCOL_ARTIFACT": `C:\%X%\artifact.json`} },
		// "C:\dir\" quoted ends in \", which the argument parser reads as a
		// literal quote, running the rest of the line into one argument.
		"trailing backslash in data dir": func(s *Spec) { s.DataDir = `C:\Users\person\data\` },
		"trailing backslash in artifact": func(s *Spec) { s.Env = map[string]string{"BACKPLANE_BEACON_ARTIFACT": `C:\artifacts\`} },
		"newline in artifact":            func(s *Spec) { s.Env = map[string]string{"BACKPLANE_BEACON_ARTIFACT": "C:\\a\nb.json"} },
		"control byte in data dir":       func(s *Spec) { s.DataDir = "C:\\data\x01dir" },
	} {
		bad := spec
		mutate(&bad)
		if _, err := New("windows", bad, &fakeRunner{}); !errors.Is(err, ErrUnsupportedPath) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

func TestRenderTask_RequiresANamedUser(t *testing.T) {
	// An empty UserId would make the logon trigger fire for every user.
	for name, user := range map[string]string{
		"no user":         "",
		"blank user":      "  ",
		"newline in user": "HOST\\person\n",
		"percent in user": `HOST\%USERNAME%`,
		"quote in user":   `HOST\per"son`,
	} {
		spec := windowsTaskSpec(t)
		spec.User = user
		if _, err := New("windows", spec, &fakeRunner{}); !errors.Is(err, ErrUnsupportedUser) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}
