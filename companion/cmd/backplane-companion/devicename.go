// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
)

const scutilTimeout = 2 * time.Second

// suggestionRetryInterval spaces out rereads after a failed read, which
// may be transient (scutil timing out while the system is busy).
const suggestionRetryInterval = time.Minute

type deviceNameSuggestion struct {
	mu         sync.Mutex
	name       *string
	lastFailed time.Time
}

// computerNameSources are where each OS keeps the name the user gave this
// computer; tests replace them so nothing is executed.
type computerNameSources struct {
	scutil   func() (string, error)
	hostname func() (string, error)
	getenv   func(string) string
}

func systemComputerNameSources() computerNameSources {
	return computerNameSources{scutil: scutilComputerName, hostname: os.Hostname, getenv: os.Getenv}
}

func scutilComputerName() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), scutilTimeout)
	defer cancel()
	output, err := scutilCommand(ctx).Output()
	return string(output), err
}

// scutilCommand runs scutil without the daemon's environment, so nothing
// inherited (DYLD_*, a hostile PATH) reaches it.
func scutilCommand(ctx context.Context) *exec.Cmd {
	command := exec.CommandContext(ctx, "/usr/sbin/scutil", "--get", "ComputerName")
	command.Env = []string{"PATH=/usr/bin:/bin"}
	return command
}

// read returns the computer's name as a valid device name, or "" when the
// OS has none that is usable.
func (s computerNameSources) read(goos string) string {
	switch goos {
	case "windows":
		if s.getenv != nil {
			return usableDeviceName(s.getenv("COMPUTERNAME"))
		}
		return ""
	case "darwin":
		if s.scutil != nil {
			if name, err := s.scutil(); err == nil {
				if usable := usableDeviceName(name); usable != "" {
					return usable
				}
			}
		}
	}
	if s.hostname == nil {
		return ""
	}
	name, err := s.hostname()
	if err != nil {
		return ""
	}
	return usableDeviceName(strings.TrimSuffix(name, ".local"))
}

// usableDeviceName drops what the server would refuse: control characters,
// and bidi or other format characters that could make the name display as
// something else on the approval page.
func usableDeviceName(raw string) string {
	cleaned := strings.Map(func(character rune) rune {
		switch {
		case unicode.IsSpace(character):
			return ' '
		case unicode.IsPrint(character):
			return character
		}
		return -1
	}, raw)
	name, ok := control.ValidDeviceName(strings.Join(strings.Fields(cleaned), " "))
	if !ok {
		return ""
	}
	return name
}

// suggestedDeviceName is what onboarding prefills the device name with:
// the computer's own name, which only leaves this computer if the user
// submits it. A success is kept for the daemon's lifetime, since reading it
// may run scutil; a failure is retried at most once per interval.
func (b *controlBackend) suggestedDeviceName() *string {
	b.suggestion.mu.Lock()
	defer b.suggestion.mu.Unlock()
	if b.suggestion.name != nil || b.app.computerName == nil {
		return b.suggestion.name
	}
	now := b.app.now()
	if !b.suggestion.lastFailed.IsZero() && now.Sub(b.suggestion.lastFailed) < suggestionRetryInterval {
		return nil
	}
	if name := b.app.computerName(); name != "" {
		b.suggestion.name = &name
	} else {
		b.suggestion.lastFailed = now
	}
	return b.suggestion.name
}
