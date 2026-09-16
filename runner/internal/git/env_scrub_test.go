// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// discoveryVars are the ambient variables that redirect repository discovery.
// Kept separate from the production gitContextVars: that list also carries
// GIT_CEILING_DIRECTORIES, which the runner re-adds deliberately and so has its
// own tests below.
var discoveryVars = []string{
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
}

func TestSubprocessEnv_ScrubsInheritedGitContextVars(t *testing.T) {
	for _, name := range discoveryVars {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "/ambient/leaked/value")

			value, found := lastValue((&Manager{BaseDir: t.TempDir()}).subprocessEnv(), name)

			if found {
				t.Fatalf("%s leaked into the subprocess env as %q: it overrides cmd.Dir, "+
					"so git would operate on the ambient repository instead of the target", name, value)
			}
		})
	}
}

// The ceiling stops git's upward discovery walk at BaseDir. Without it, a git
// command run in a non-repo directory under BaseDir keeps walking up and binds
// to an *enclosing* repository — the exact failure that rewound the live repo
// when a relative base_dir resolved inside the working tree.
func TestSubprocessEnv_PinsCeilingToBaseDir(t *testing.T) {
	base := t.TempDir()

	value, found := lastValue((&Manager{BaseDir: base}).subprocessEnv(), "GIT_CEILING_DIRECTORIES")

	if !found {
		t.Fatal("GIT_CEILING_DIRECTORIES not set on subprocess env")
	}
	if value != base {
		t.Fatalf("ceiling pinned to %q, want BaseDir %q", value, base)
	}
}

// Scrubbing has to happen before the deliberate set, otherwise an ambient value
// (or a duplicate key) decides the effective ceiling. exec resolves a repeated
// key to its final occurrence, so lastValue is the value git actually sees.
func TestSubprocessEnv_AmbientCeilingCannotOverride(t *testing.T) {
	t.Setenv("GIT_CEILING_DIRECTORIES", "/attacker/controlled")
	base := t.TempDir()

	value, found := lastValue((&Manager{BaseDir: base}).subprocessEnv(), "GIT_CEILING_DIRECTORIES")

	if !found {
		t.Fatal("GIT_CEILING_DIRECTORIES not set on subprocess env")
	}
	if value != base {
		t.Fatalf("ambient env decided the ceiling: got %q, want BaseDir %q", value, base)
	}
}

// The harness constructs a bare &git.Manager{} and drives it with an explicit
// repoDir, so there is no BaseDir to pin. An empty ceiling is meaningless (git
// would treat "" as a no-op entry), so the pin must simply be absent — but the
// ambient value must still be scrubbed, otherwise the no-BaseDir path is the
// one place an attacker-controlled ceiling survives.
func TestSubprocessEnv_NoCeilingWhenBaseDirEmpty(t *testing.T) {
	t.Setenv("GIT_CEILING_DIRECTORIES", "/attacker/controlled")

	value, found := lastValue((&Manager{}).subprocessEnv(), "GIT_CEILING_DIRECTORIES")

	if found {
		t.Fatalf("GIT_CEILING_DIRECTORIES present as %q with no BaseDir: "+
			"expected the ambient value to be scrubbed and no pin added", value)
	}
}

// Git ignores a ceiling entry that is not absolute — silently. Pinning one
// anyway produces an env that looks contained and is not: discovery walks
// straight past it into the enclosing repository, which is the shape of the
// incident this whole guard exists to prevent. Config load absolutises BaseDir,
// so this is about Managers built off that path.
func TestSubprocessEnv_NoCeilingWhenBaseDirIsRelative(t *testing.T) {
	value, found := lastValue((&Manager{BaseDir: "repos"}).subprocessEnv(), "GIT_CEILING_DIRECTORIES")

	if found {
		t.Fatalf("pinned a relative ceiling %q: git ignores non-absolute entries, so this "+
			"reads as containment while discovery still escapes into any enclosing repo", value)
	}
}

// Acceptance: real git, real repositories, real `reset --hard`.
//
// WipeToHead is the runner's stage-entry wipe. It targets repoDir via cmd.Dir,
// but ambient GIT_DIR + GIT_WORK_TREE outrank cmd.Dir entirely, so without a
// scrub the wipe reverts the victim's tracked file and deletes its untracked
// file while the intended target is left dirty. Both repos are real clones with
// real commits, so this discriminates on behavior rather than on env strings.
func TestWipeToHead_AmbientGitDirCannotRedirectTheWipe(t *testing.T) {
	base := t.TempDir()
	victim := initRepoWithCommit(t, filepath.Join(base, "victim"))
	target := initRepoWithCommit(t, filepath.Join(base, "target"))

	// Dirty both trees so a wipe is observable in either one.
	writeFile(t, filepath.Join(victim, "tracked.txt"), "victim-uncommitted-work")
	writeFile(t, filepath.Join(victim, "untracked.txt"), "victim-scratch")
	writeFile(t, filepath.Join(target, "tracked.txt"), "target-uncommitted-work")

	t.Setenv("GIT_DIR", filepath.Join(victim, ".git"))
	t.Setenv("GIT_WORK_TREE", victim)

	m := &Manager{BaseDir: base}
	if err := m.WipeToHead(context.Background(), target); err != nil {
		t.Fatalf("WipeToHead on the intended repo failed: %v", err)
	}

	if got := readFile(t, filepath.Join(victim, "tracked.txt")); got != "victim-uncommitted-work" {
		t.Fatalf("ambient GIT_DIR redirected `reset --hard` onto the victim repo: "+
			"tracked.txt is %q, want %q", got, "victim-uncommitted-work")
	}
	if _, err := os.Stat(filepath.Join(victim, "untracked.txt")); err != nil {
		t.Fatalf("ambient GIT_WORK_TREE redirected `clean -fd` onto the victim repo: "+
			"untracked.txt was deleted (%v)", err)
	}
	if got := readFile(t, filepath.Join(target, "tracked.txt")); got != "committed" {
		t.Fatalf("the intended repo was not wiped: tracked.txt is %q, want %q", got, "committed")
	}
}

// Acceptance: the ceiling must stop git's upward walk out of BaseDir. A repo
// directory that has been emptied (a wiped/corrupt clone) is a plain directory,
// so discovery walks up — and binds to the repository enclosing BaseDir. That
// is the base_dir incident: the runner's git commands reached the live worktree.
func TestManager_DiscoveryCannotEscapeBaseDirIntoEnclosingRepo(t *testing.T) {
	enclosing := initRepoWithCommit(t, filepath.Join(t.TempDir(), "enclosing"))
	base := filepath.Join(enclosing, "repos")
	notARepo := filepath.Join(base, "board-clone")
	if err := os.MkdirAll(notARepo, 0o755); err != nil {
		t.Fatal(err)
	}

	m := &Manager{BaseDir: base}
	branch, err := m.CurrentBranch(context.Background(), notARepo)

	if err == nil {
		t.Fatalf("git discovery escaped BaseDir and bound to the enclosing repo (branch %q): "+
			"a mutating command would have operated on it", branch)
	}
}

// configInjectionVars are the ambient variables that let the environment inject
// arbitrary git *configuration* into a child. Unlike the discovery vars they do
// not redirect which repository is touched — they decide what git runs. The
// reachable prize is core.hooksPath, which has no env var of its own: pointing
// it at an attacker-writable directory makes `git commit` execute an arbitrary
// pre-commit binary. GIT_SSH/GIT_SSH_COMMAND and GIT_EXTERNAL_DIFF are direct
// command hooks; GIT_TEMPLATE_DIR plants hooks into every new clone; the object
// and namespace vars redirect where objects are read and written.
//
// Declared here rather than referenced from the production package on purpose:
// the scrub list does not exist yet, and naming a missing identifier would fail
// the build instead of failing the assertion.
var configInjectionVars = []string{
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
	"GIT_EXTERNAL_DIFF",
	"GIT_TEMPLATE_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PROXY_COMMAND",
	"GIT_EXEC_PATH",
	"LD_PRELOAD",
	"DYLD_INSERT_LIBRARIES",
}

func TestSubprocessEnv_ScrubsConfigInjectionVars(t *testing.T) {
	for _, name := range configInjectionVars {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "/ambient/attacker/value")

			value, found := lastValue((&Manager{BaseDir: t.TempDir()}).subprocessEnv(), name)

			if found {
				t.Fatalf("%s leaked into the subprocess env as %q: the ambient environment "+
					"decides git's configuration, up to and including core.hooksPath", name, value)
			}
		})
	}
}

// The numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs take arbitrary
// indices — GIT_CONFIG_COUNT=8 with the payload at slot 7 executes exactly like
// slot 0. There is no finite list to enumerate, so the scrub has to match on the
// key *prefix*; withoutKeys only matches whole keys today, which is precisely
// what this pins.
func TestSubprocessEnv_ScrubsNumberedConfigPairs(t *testing.T) {
	numbered := []string{
		"GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0",
		"GIT_CONFIG_KEY_7",
		"GIT_CONFIG_VALUE_7",
	}
	for _, name := range numbered {
		t.Setenv(name, "core.hooksPath")
	}

	env := (&Manager{BaseDir: t.TempDir()}).subprocessEnv()

	for _, name := range numbered {
		if value, found := lastValue(env, name); found {
			t.Errorf("%s leaked into the subprocess env as %q: indices are arbitrary, so the "+
				"scrub must match the GIT_CONFIG_KEY_/GIT_CONFIG_VALUE_ prefix, not a fixed list",
				name, value)
		}
	}
}

// Acceptance: real git, a real repository, a real hook that really executes.
//
// GIT_CONFIG_COUNT + GIT_CONFIG_KEY_0=core.hooksPath is arbitrary code execution
// in the runner's own process tree: every `git commit` the runner makes runs the
// ambient pre-commit binary with the runner's credentials. Env-string assertions
// say the variable is gone; only this says the execution path is closed.
func TestCommitAll_AmbientHooksPathCannotExecute(t *testing.T) {
	base := t.TempDir()
	// Built before the ambient vars are set: runGit does not clear the config
	// family, so fixture setup would trip the hook itself and the assertion
	// would be measuring its own scaffolding.
	repo := initRepoWithCommit(t, filepath.Join(base, "target"))

	canary := filepath.Join(base, "pwned")
	hooksDir := filepath.Join(base, "evil-hooks")
	writeHook(t, hooksDir, canary)

	// A real change, so HasChanges passes and `git commit` actually runs —
	// otherwise CommitAll returns early and the test passes vacuously.
	writeFile(t, filepath.Join(repo, "tracked.txt"), "executor-work")

	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.hooksPath")
	t.Setenv("GIT_CONFIG_VALUE_0", hooksDir)

	m := &Manager{BaseDir: base}
	if err := m.CommitAll(context.Background(), repo, "executor commit"); err != nil {
		t.Fatalf("CommitAll on the intended repo failed: %v", err)
	}

	if _, err := os.Stat(canary); err == nil {
		t.Fatal("ambient GIT_CONFIG_* injected core.hooksPath: the pre-commit hook executed " +
			"during CommitAll — arbitrary code ran with the runner's credentials")
	}
}

// GIT_CONFIG_PARAMETERS is git's internal transport for `-c`, and it is honoured
// with GIT_CONFIG_COUNT unset entirely — so a scrub that treats the counter as
// the gate to the config family leaves this door wide open. It reaches the same
// core.hooksPath execution as the numbered pairs.
func TestCommitAll_AmbientConfigParametersCannotExecuteHooks(t *testing.T) {
	base := t.TempDir()
	repo := initRepoWithCommit(t, filepath.Join(base, "target"))

	canary := filepath.Join(base, "pwned-params")
	hooksDir := filepath.Join(base, "evil-hooks-params")
	writeHook(t, hooksDir, canary)

	writeFile(t, filepath.Join(repo, "tracked.txt"), "executor-work")

	// Deliberately no GIT_CONFIG_COUNT: this must fail closed without it.
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.hooksPath'='"+hooksDir+"'")

	m := &Manager{BaseDir: base}
	if err := m.CommitAll(context.Background(), repo, "executor commit"); err != nil {
		t.Fatalf("CommitAll on the intended repo failed: %v", err)
	}

	if _, err := os.Stat(canary); err == nil {
		t.Fatal("ambient GIT_CONFIG_PARAMETERS injected core.hooksPath with GIT_CONFIG_COUNT unset: " +
			"the pre-commit hook executed during CommitAll")
	}
}

// Same injection expressed through a config *file* rather than the numbered
// pairs. GIT_CONFIG_GLOBAL replaces ~/.gitconfig wholesale, so a [core]
// hooksPath in it reaches the same execution path by a different door.
func TestCommitAll_AmbientGlobalConfigCannotExecuteHooks(t *testing.T) {
	base := t.TempDir()
	repo := initRepoWithCommit(t, filepath.Join(base, "target"))

	canary := filepath.Join(base, "pwned-global")
	hooksDir := filepath.Join(base, "evil-hooks-global")
	writeHook(t, hooksDir, canary)

	evilConfig := filepath.Join(base, "evil.gitconfig")
	writeFile(t, evilConfig, "[core]\n\thooksPath = "+hooksDir+"\n")

	writeFile(t, filepath.Join(repo, "tracked.txt"), "executor-work")

	t.Setenv("GIT_CONFIG_GLOBAL", evilConfig)

	m := &Manager{BaseDir: base}
	if err := m.CommitAll(context.Background(), repo, "executor commit"); err != nil {
		t.Fatalf("CommitAll on the intended repo failed: %v", err)
	}

	if _, err := os.Stat(canary); err == nil {
		t.Fatal("ambient GIT_CONFIG_GLOBAL supplied a [core] hooksPath: the pre-commit hook " +
			"executed during CommitAll")
	}
}

// Acceptance: GIT_EXEC_PATH relocates the directory git loads its helper
// binaries from. Built-in subcommands are compiled in and unaffected, but the
// transport helpers are real executables — git-remote-https serves every https
// clone, fetch and push the runner makes, so an attacker-controlled exec path is
// code execution on the runner's hottest route.
func TestCloneOrOpen_AmbientExecPathCannotExecute(t *testing.T) {
	base := t.TempDir()
	source := initRepoWithCommit(t, filepath.Join(base, "source"))

	canary := filepath.Join(base, "pwned-execpath")
	fakeExecDir := filepath.Join(base, "evil-exec")
	if err := os.MkdirAll(fakeExecDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Shadow the helpers a clone reaches for. Each marks the canary and exits 0,
	// so execution is observable even when the clone itself then fails.
	for _, helper := range []string{"git-remote-https", "git-remote-http", "git-upload-pack"} {
		script := "#!/bin/sh\necho pwned > " + canary + "\n"
		if err := os.WriteFile(filepath.Join(fakeExecDir, helper), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	t.Setenv("GIT_EXEC_PATH", fakeExecDir)

	m := &Manager{BaseDir: base}
	// A file:// source keeps the test off the network; the point is whether the
	// ambient exec path reaches the child at all, not which transport runs.
	_, _ = m.CloneOrOpen(context.Background(), "file://"+source, "clone")

	if _, err := os.Stat(canary); err == nil {
		t.Fatal("ambient GIT_EXEC_PATH reached the git child: git would load its helper " +
			"binaries from an attacker-controlled directory")
	}
}

// writeHook creates a hooks directory whose pre-commit marks canary on execution.
func writeHook(t *testing.T, hooksDir, canary string) {
	t.Helper()
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(hooksDir, "pre-commit")
	script := "#!/bin/sh\necho pwned > " + canary + "\n"
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func initRepoWithCommit(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "tracked.txt"), "committed")

	// A pristine env: these helpers must not inherit the ambient GIT_DIR the
	// tests deliberately set, or they would build the fixture in the wrong repo.
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "runner@test.local"},
		{"config", "user.name", "runner"},
		{"add", "-A"},
		{"commit", "-m", "init"},
	} {
		runGit(t, dir, args...)
	}
	return dir
}

// runGit drives git for fixture setup with every hijackable var cleared. These
// tests set ambient GIT_DIR and core.hooksPath injections on purpose, and the
// fixture builder must inherit none of them — setup runs a real `git commit`, so
// otherwise it would trip the hook itself and the assertions would be measuring
// their own scaffolding. Clearing both classes here makes that structural rather
// than a matter of remembering to build fixtures before calling t.Setenv.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	env := withoutKeys(os.Environ(), gitContextVars...)
	env = withoutKeys(env, gitConfigVars...)
	cmd.Env = withoutPrefixes(env, gitConfigPrefixes...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
