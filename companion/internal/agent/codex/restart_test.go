// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/process"
)

// fakeProcess is one row of a fake process table; no real process is read.
type fakeProcess struct {
	executable string
	argv       []string
	startedAt  time.Time
}

type fakeFinder struct {
	table []fakeProcess
	err   error
}

func (f *fakeFinder) Find(query process.Query) ([]process.Process, error) {
	if f.err != nil {
		return nil, f.err
	}
	var found []process.Process
	for index, row := range f.table {
		if query.Executable(row.executable) && query.Arguments(row.argv) {
			found = append(found, process.Process{PID: 100 + index, Executable: row.executable, StartedAt: row.startedAt})
		}
	}
	return found, nil
}

const desktopAppServer = "/Applications/ChatGPT.app/Contents/Resources/codex"

func desktopRow(startedAt time.Time) fakeProcess {
	return fakeProcess{executable: desktopAppServer, argv: []string{desktopAppServer, "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"}, startedAt: startedAt}
}

func (e testEnv) daemonRow(startedAt time.Time, argv ...string) fakeProcess {
	executable := filepath.Join(e.codexHome, "packages", "app-server-daemon", "releases", "0.159.0-aarch64-apple-darwin", "bin", "codex")
	if len(argv) == 0 {
		argv = []string{"app-server", "--listen", "unix://", "--managed-daemon"}
	}
	return fakeProcess{executable: executable, argv: append([]string{executable}, argv...), startedAt: startedAt}
}

// installed returns an env with the companion's integration installed and
// the time the install was recorded.
func installed(t *testing.T, finder *fakeFinder) (testEnv, time.Time) {
	t.Helper()
	env := newEnv(t)
	env.StateDir = filepath.Join(filepath.Dir(env.Home), "data")
	os.MkdirAll(env.StateDir, 0o700)
	env.Processes = finder
	before := time.Now().Truncate(time.Second)
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	return env, before
}

func problems(status agent.IntegrationStatus) map[string]bool {
	found := map[string]bool{}
	for _, problem := range status.Problems {
		found[problem] = true
	}
	return found
}

func TestRestartRequired_AppServerStartedBeforeTheInstall(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	finder.table = []fakeProcess{desktopRow(installedAt.Add(-7 * 24 * time.Hour))}

	status := New().Status(env.Env)
	if !problems(status)[agent.ProblemRestartRequired] {
		t.Fatalf("a stale Codex app-server must report %s; got %+v", agent.ProblemRestartRequired, status)
	}
	if status.State == agent.Broken {
		t.Fatalf("the integration itself is fine; restarting is not a repair: state %s", status.State)
	}
	if _, mapped := status.ProblemConfigPaths[agent.ProblemRestartRequired]; mapped {
		t.Fatal("a restart concerns no config file")
	}
	if !agent.KnownProblem(agent.ProblemRestartRequired) || !agent.KnownProblem(agent.ProblemDaemonRestartRequired) {
		t.Fatal("the restart codes are documented problem codes")
	}
}

func TestRestartRequired_AppServerStartedAfterTheInstallIsFine(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	finder.table = []fakeProcess{desktopRow(installedAt.Add(time.Hour))}
	if status := New().Status(env.Env); problems(status)[agent.ProblemRestartRequired] {
		t.Fatalf("a Codex app started after the install reads the hooks: %+v", status)
	}
}

func TestRestartRequired_AppServerStartedInTheInstallSecondIsFine(t *testing.T) {
	finder := &fakeFinder{}
	env, _ := installed(t, finder)
	// ps reports whole seconds; a process started in the install's own second
	// may have read the new files, so it is not flagged.
	finder.table = []fakeProcess{desktopRow(installChangedAt(env.Env).Truncate(time.Second))}
	if status := New().Status(env.Env); problems(status)[agent.ProblemRestartRequired] {
		t.Fatalf("same-second start flagged: %+v", status)
	}
}

func TestRestartRequired_CodexCLIIsNeverFlagged(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	old := installedAt.Add(-48 * time.Hour)
	finder.table = []fakeProcess{
		{executable: "/opt/homebrew/Caskroom/codex/0.159.0/bin/codex", argv: []string{"codex"}, startedAt: old},
		{executable: "/opt/homebrew/Caskroom/codex/0.159.0/bin/codex", argv: []string{"codex", "app-server"}, startedAt: old},
		{executable: desktopAppServer, argv: []string{desktopAppServer, "exec", "fix it"}, startedAt: old},
		{executable: "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host", argv: []string{"codex-code-mode-host", "app-server"}, startedAt: old},
	}
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("terminal Codex, a non app-server run and other bundle helpers are not the app: %+v", status)
	}
}

func TestRestartRequired_NoProcessNoProblem(t *testing.T) {
	finder := &fakeFinder{}
	env, _ := installed(t, finder)
	if status := New().Status(env.Env); len(status.Problems) != 0 || status.State != agent.NeedsTrust {
		t.Fatalf("nothing running: %+v", status)
	}
}

func TestRestartRequired_ListerErrorIsNoFalseAlarm(t *testing.T) {
	finder := &fakeFinder{err: errors.New("ps: timed out")}
	env, _ := installed(t, finder)
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("an unreadable process table must not warn: %+v", status)
	}
}

func TestRestartRequired_NoFinderSkipsTheCheck(t *testing.T) {
	env, _ := installed(t, nil)
	env.Processes = nil
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("no finder: %+v", status)
	}
}

func TestRestartRequired_NotInstalledNeverWarns(t *testing.T) {
	env := newEnv(t)
	env.Processes = &fakeFinder{table: []fakeProcess{desktopRow(time.Now().Add(-time.Hour))}}
	if status := New().Status(env.Env); status.State != agent.NotInstalled || len(status.Problems) != 0 {
		t.Fatalf("without the companion's hooks a restart changes nothing: %+v", status)
	}
}

func TestRestartRequired_ClearsOnceTheAppRestarted(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	finder.table = []fakeProcess{desktopRow(installedAt.Add(-time.Hour))}
	if !problems(New().Status(env.Env))[agent.ProblemRestartRequired] {
		t.Fatal("stale app-server not flagged")
	}
	finder.table = []fakeProcess{desktopRow(installedAt.Add(time.Hour))}
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("after the restart: %+v", status)
	}
}

func TestDaemonRestartRequired_StaleManagedDaemon(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	old := installedAt.Add(-time.Hour)
	finder.table = []fakeProcess{env.daemonRow(old), env.daemonRow(old, "app-server", "daemon", "pid-update-loop")}
	status := New().Status(env.Env)
	found := problems(status)
	if !found[agent.ProblemDaemonRestartRequired] || found[agent.ProblemRestartRequired] {
		t.Fatalf("a stale managed daemon is restarted on its own, not by quitting the app: %+v", status.Problems)
	}
	if len(status.Problems) != 1 {
		t.Fatalf("one problem for the daemon: %+v", status.Problems)
	}

	finder.table = []fakeProcess{env.daemonRow(installedAt.Add(time.Hour)), env.daemonRow(old, "app-server", "daemon", "pid-update-loop")}
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("the daemon's own updater loop hosts no session: %+v", status.Problems)
	}
}

func TestIntegrationChange_RecordedOnlyWhenTheCompanionChangesSomething(t *testing.T) {
	env, _ := installed(t, &fakeFinder{})
	first := installChangedAt(env.Env)
	if first.IsZero() {
		t.Fatal("install recorded no change time")
	}
	time.Sleep(20 * time.Millisecond)
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if again := installChangedAt(env.Env); !again.Equal(first) {
		t.Fatalf("an install that changed nothing moved the time from %v to %v", first, again)
	}

	time.Sleep(20 * time.Millisecond)
	env.Telemetry.Endpoint = "http://127.0.0.1:14999"
	if _, err := New().Repair(env.Env); err != nil {
		t.Fatal(err)
	}
	if repaired := installChangedAt(env.Env); !repaired.After(first) {
		t.Fatalf("a repair that rewrote the telemetry block must record it: %v !after %v", repaired, first)
	}
}

func TestIntegrationChange_FallsBackToTheHooksFileTime(t *testing.T) {
	finder := &fakeFinder{}
	env, _ := installed(t, finder)
	os.Remove(filepath.Join(env.StateDir, integrationChangeFile))
	hooksTime := time.Date(2026, 9, 29, 9, 24, 0, 0, time.UTC)
	os.Chtimes(env.hooksFile(), hooksTime, hooksTime)
	finder.table = []fakeProcess{desktopRow(time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC))}
	if !problems(New().Status(env.Env))[agent.ProblemRestartRequired] {
		t.Fatal("an install from before this version is dated by hooks.json")
	}
	finder.table = []fakeProcess{desktopRow(hooksTime.Add(time.Minute))}
	if status := New().Status(env.Env); len(status.Problems) != 0 {
		t.Fatalf("%+v", status.Problems)
	}
}

func TestRestartRequired_OnlyInstalledAppBundlesCount(t *testing.T) {
	finder := &fakeFinder{}
	env, installedAt := installed(t, finder)
	old := installedAt.Add(-time.Hour)
	userApps := filepath.Join(env.Home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")
	finder.table = []fakeProcess{{executable: userApps, argv: []string{userApps, "app-server"}, startedAt: old}}
	if !problems(New().Status(env.Env))[agent.ProblemRestartRequired] {
		t.Fatal("~/Applications is an installed app")
	}
	for _, elsewhere := range []string{"/Volumes/ChatGPT/ChatGPT.app/Contents/Resources/codex", filepath.Join(env.Home, "Downloads", "ChatGPT.app", "Contents", "Resources", "codex")} {
		finder.table = []fakeProcess{{executable: elsewhere, argv: []string{elsewhere, "app-server"}, startedAt: old}}
		if status := New().Status(env.Env); len(status.Problems) != 0 {
			t.Fatalf("%s is not an installed app: %+v", elsewhere, status.Problems)
		}
	}
}
