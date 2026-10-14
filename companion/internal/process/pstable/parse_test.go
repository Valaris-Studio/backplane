// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pstable

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/process"
)

func TestParseList_KeepsOnlyTheUsersProcessesWithStartAndPath(t *testing.T) {
	output := strings.Join([]string{
		"  9309   501 Tue Sep 29 11:18:04 2026     /Applications/ChatGPT.app/Contents/Resources/codex",
		"  8736   501 Tue Sep  1 09:05:06 2026     /Applications/ChatGPT.app/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service)",
		"   700     0 Mon Sep 28 08:00:00 2026     /Applications/ChatGPT.app/Contents/Resources/codex",
		"garbage line",
		"  1234   501 Xyz Abc 99 99:99:99 2026     /bin/broken-date",
		"12026   501 Tue Sep 29 11:18:04 2026     /Applications/Codex.app/Contents/Resources/codex 2026",
		"",
	}, "\n")
	found := parseList([]byte(output), 501)
	want := []process.Process{
		{PID: 9309, Executable: "/Applications/ChatGPT.app/Contents/Resources/codex", StartedAt: time.Date(2026, 9, 29, 11, 18, 4, 0, time.UTC)},
		{PID: 8736, Executable: "/Applications/ChatGPT.app/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service)", StartedAt: time.Date(2026, 9, 1, 9, 5, 6, 0, time.UTC)},
		{PID: 12026, Executable: "/Applications/Codex.app/Contents/Resources/codex 2026", StartedAt: time.Date(2026, 9, 29, 11, 18, 4, 0, time.UTC)},
	}
	if !reflect.DeepEqual(found, want) {
		t.Fatalf("parsed %+v\nwant %+v", found, want)
	}
}

func TestParseArguments_SplitsEachPidsArgv(t *testing.T) {
	output := " 9309 /Applications/ChatGPT.app/Contents/Resources/codex -c features.x=true app-server --analytics-default-enabled\n58077 /home/me/.codex/packages/app-server-daemon/releases/0.159.0/bin/codex app-server --listen unix://\nnot-a-pid x\n"
	found := parseArguments([]byte(output))
	if got := found[9309]; len(got) != 5 || got[3] != "app-server" {
		t.Fatalf("9309 argv %q", got)
	}
	if got := found[58077]; len(got) != 4 || got[1] != "app-server" {
		t.Fatalf("58077 argv %q", got)
	}
	if len(found) != 2 {
		t.Fatalf("parsed %d entries, want 2", len(found))
	}
}
