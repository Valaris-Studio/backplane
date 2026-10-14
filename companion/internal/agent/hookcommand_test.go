// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// echoArgsEnv turns this test binary into a stand-in companion that prints
// its arguments, so a generated hook command can be run for real.
const echoArgsEnv = "BACKPLANE_HOOKCOMMAND_ECHO_ARGS"

func TestMain(m *testing.M) {
	if os.Getenv(echoArgsEnv) == "1" {
		fmt.Print(strings.Join(os.Args[1:], "\n"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestHookCommandFitsEachAgentsShell(t *testing.T) {
	cases := []struct {
		name, goos, executable, hook string
		shell                        agent.WindowsHookShell
		want                         string
	}{
		{"posix", "linux", "/opt/Backplane Companion/backplane-companion", "codex", agent.PowerShell, `'/opt/Backplane Companion/backplane-companion' hook codex`},
		{"posix single quote", "darwin", "/opt/it's/backplane-companion", "claude-code", agent.GitBash, `'/opt/it'"'"'s/backplane-companion' hook claude-code`},
		// Git Bash single quotes keep every character literal; inside double
		// quotes a UNC path's leading \\ would collapse.
		{"git bash", "windows", `C:\Program Files\Backplane\backplane-companion.exe`, "claude-code", agent.GitBash, `'C:\Program Files\Backplane\backplane-companion.exe' hook claude-code`},
		{"git bash unc", "windows", `\\server\share\backplane-companion.exe`, "claude-code", agent.GitBash, `'\\server\share\backplane-companion.exe' hook claude-code`},
		{"git bash quote and dollar", "windows", `C:\$Recycle\O'Brien\backplane-companion.exe`, "claude-code", agent.GitBash, `'C:\$Recycle\O'"'"'Brien\backplane-companion.exe' hook claude-code`},
		// PowerShell parses a leading quoted string as a value, so the call
		// operator is what makes it run the path.
		{"powershell spaces", "windows", `C:\Program Files\Backplane\backplane-companion.exe`, "codex", agent.PowerShell, `& "C:\Program Files\Backplane\backplane-companion.exe" hook codex`},
		{"powershell single quote", "windows", `C:\Users\O'Brien\bin\backplane-companion.exe`, "codex", agent.PowerShell, `& "C:\Users\O'Brien\bin\backplane-companion.exe" hook codex`},
	}
	for _, c := range cases {
		got, err := agent.HookCommandFor(c.goos, c.executable, c.hook, c.shell)
		if err != nil || got != c.want {
			t.Errorf("%s: %q %v, want %q", c.name, got, err, c.want)
		}
		if !agent.IsOwnedHookCommand(got, c.hook) {
			t.Errorf("%s: generated command not recognised as owned: %q", c.name, got)
		}
	}
}

func TestHookCommandRefusesPathsItCannotQuote(t *testing.T) {
	refused := []struct {
		goos, executable string
		shell            agent.WindowsHookShell
	}{
		{"linux", "bin/backplane-companion", agent.GitBash},
		{"linux", "/opt/new\nline/backplane-companion", agent.GitBash},
		{"windows", `bin\backplane-companion.exe`, agent.PowerShell},
		{"windows", `bin\backplane-companion.exe`, agent.GitBash},
		{"windows", `C:\a"b\backplane-companion.exe`, agent.PowerShell},
		// PowerShell expands these inside double quotes, and may read
		// brackets in a command path as a wildcard.
		{"windows", `C:\$Recycle\backplane-companion.exe`, agent.PowerShell},
		{"windows", `C:\tools[1]\backplane-companion.exe`, agent.PowerShell},
		{"windows", `C:\tools]\backplane-companion.exe`, agent.PowerShell},
		{"windows", "C:\\a`b\\backplane-companion.exe", agent.PowerShell},
		// PowerShell also closes a double-quoted string at typographic quotes.
		{"windows", "C:\\\u201cx\u201d\\backplane-companion.exe", agent.PowerShell},
	}
	for _, c := range refused {
		if command, err := agent.HookCommandFor(c.goos, c.executable, "codex", c.shell); !errors.Is(err, agent.ErrConfigInvalid) {
			t.Errorf("%s %q: %q %v, want refusal", c.goos, c.executable, command, err)
		}
	}
}

func TestOwnedHookCommandRecognisesEveryFormEverWritten(t *testing.T) {
	owned := []string{
		`'/opt/bin/backplane-companion' hook codex`,
		// Every agent on Windows, as written by 088be924.
		`"C:\Program Files\Backplane\backplane-companion.exe" hook codex`,
		`& "C:\Program Files\Backplane\backplane-companion.exe" hook codex`,
		`'C:\Program Files\Backplane\backplane-companion.exe' hook codex`,
		// The windowless daemon repointed hooks at itself before CR-10.
		`"C:\Backplane\backplane-companiond.exe" hook codex`,
	}
	for _, command := range owned {
		if !agent.IsOwnedHookCommand(command, "codex") {
			t.Errorf("not recognised: %s", command)
		}
	}
	foreign := []string{
		`& "C:\tools\guard.exe" hook codex`,
		`& "C:\Backplane\backplane-companion.exe" hook claude-code`,
		`"C:\Backplane\backplane-companion.exe" hook codex --extra`,
		`guard.sh`,
	}
	for _, command := range foreign {
		if agent.IsOwnedHookCommand(command, "codex") {
			t.Errorf("foreign command claimed: %s", command)
		}
	}
}

func TestPowerShellRunsTheCodexHookCommand(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PowerShell runs Codex hooks only on Windows")
	}
	companion := standInCompanion(t)
	command, err := agent.HookCommand(companion, "codex", agent.PowerShell)
	if err != nil {
		t.Fatal(err)
	}
	shell := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	shell.Env = append(os.Environ(), echoArgsEnv+"=1")
	output, err := shell.CombinedOutput()
	if err != nil || strings.TrimSpace(strings.ReplaceAll(string(output), "\r\n", "\n")) != "hook\ncodex" {
		t.Fatalf("PowerShell ran %q: %v\n%s", command, err, output)
	}
}

func TestGitBashRunsTheClaudeCodeHookCommand(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Claude Code runs hooks through Git Bash only on Windows")
	}
	bash, err := exec.LookPath("bash")
	// System32's bash.exe is WSL, which cannot run a Windows path.
	if err != nil || strings.Contains(strings.ToLower(bash), `\system32\`) {
		t.Skip("Git Bash is not on PATH")
	}
	companion := standInCompanion(t)
	command, err := agent.HookCommand(companion, "claude-code", agent.GitBash)
	if err != nil {
		t.Fatal(err)
	}
	shell := exec.Command(bash, "-c", command)
	shell.Env = append(os.Environ(), echoArgsEnv+"=1")
	output, err := shell.CombinedOutput()
	if err != nil || strings.TrimSpace(strings.ReplaceAll(string(output), "\r\n", "\n")) != "hook\nclaude-code" {
		t.Fatalf("Git Bash ran %q: %v\n%s", command, err, output)
	}
}

// standInCompanion copies this test binary to a companion path with a space
// and a single quote in it.
func standInCompanion(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "Backplane O'Brien Companion")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	companion := filepath.Join(dir, "backplane-companion.exe")
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(companion, data, 0o700); err != nil {
		t.Fatal(err)
	}
	return companion
}
