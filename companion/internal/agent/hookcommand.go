// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// WindowsHookShell is the shell an agent runs hook commands through on
// Windows; elsewhere every agent uses a POSIX shell.
type WindowsHookShell int

const (
	// GitBash: Claude Code runs hooks through Git Bash, which takes the POSIX
	// single-quoted form; double quotes would collapse a UNC path's \\.
	GitBash WindowsHookShell = iota
	// PowerShell: Codex runs hooks through PowerShell, which reads a leading
	// quoted path as a string value unless the call operator & precedes it.
	PowerShell
)

// powerShellCallPrefix is the call operator that makes PowerShell run a
// quoted path instead of reading it as a string.
const powerShellCallPrefix = "& "

// HookCommand is the shell command an agent runs for a companion-owned hook:
// the quoted companion path followed by "hook <name>".
func HookCommand(executable, name string, shell WindowsHookShell) (string, error) {
	return HookCommandFor(runtime.GOOS, executable, name, shell)
}

// HookCommandFor is HookCommand for a given OS, so every form is testable
// anywhere.
func HookCommandFor(goos, executable, name string, shell WindowsHookShell) (string, error) {
	if !isAbsFor(goos, executable) || strings.ContainsAny(executable, "\x00\r\n") {
		return "", fmt.Errorf("%w: companion path must be absolute", ErrConfigInvalid)
	}
	if goos != "windows" || shell == GitBash {
		return "'" + strings.ReplaceAll(executable, "'", `'"'"'`) + "' hook " + name, nil
	}
	// Inside PowerShell double quotes $ and ` expand, typographic quotes close
	// the string, and [ ] may be read as a wildcard in a command path.
	if strings.ContainsAny(executable, "\"$`[]\u201c\u201d\u201e") {
		return "", fmt.Errorf("%w: unsupported character in companion path", ErrConfigInvalid)
	}
	return powerShellCallPrefix + `"` + executable + `" hook ` + name, nil
}

func isAbsFor(goos, path string) bool {
	if goos != "windows" {
		return strings.HasPrefix(path, "/")
	}
	if goos == runtime.GOOS {
		return filepath.IsAbs(path)
	}
	driveLetter := len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/') && 'a' <= path[0]|0x20 && path[0]|0x20 <= 'z'
	return driveLetter || strings.HasPrefix(path, `\\`)
}

// IsOwnedHookCommand reports whether command is a companion hook for name,
// whichever companion executable it points at and whichever quoting form
// wrote it, including the double-quoted Windows form of 088be924.
func IsOwnedHookCommand(command, name string) bool {
	executable, found := strings.CutSuffix(command, " hook "+name)
	if !found {
		return false
	}
	executable = strings.TrimPrefix(executable, powerShellCallPrefix)
	if len(executable) >= 2 && executable[0] == '\'' && executable[len(executable)-1] == '\'' {
		executable = strings.ReplaceAll(executable[1:len(executable)-1], `'"'"'`, "'")
	} else {
		executable = strings.Trim(executable, `"`)
	}
	base := executable[strings.LastIndexAny(executable, `/\`)+1:]
	return strings.HasPrefix(base, "backplane-companion")
}
